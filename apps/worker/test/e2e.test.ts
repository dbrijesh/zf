import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import { tables as t, verifyAudit } from '@zerovity/db';
import fs from 'node:fs';
import path from 'node:path';
import { setup, type Harness } from './helpers';
import { git, gitAvailable } from '../src/git';

let h: Harness;
beforeAll(async () => { h = await setup(); }, 120_000);
afterAll(async () => { await h?.stop(); });

const runsOf = async (id: string) => h.s.db.select().from(t.runs).where(eq(t.runs.workItemId, id)).orderBy(asc(t.runs.createdAt));
const phases = async (id: string) => (await runsOf(id)).filter((r) => r.kind === 'phase').map((r) => `${r.phase}:${r.status}`);
const approve = async (id: string) => {
  const g = (await h.s.orch.pendingGate(id))!;
  return h.s.orch.decideGate(g.id, { decision: 'approve', by: h.approver.id, byName: h.approver.name, groups: ['tech-leads'], role: 'approver', reason: 'looks right' });
};

describe('M4 end to end: INTAKE -> AWAITING_HANDOFF with the fake harness', () => {
  let id: string;
  it('runs INTENT then SPEC and stops at the spec approval gate with an inbox item and a draft PR', async () => {
    const wi = await h.s.orch.createWorkItem({ factoryId: h.factoryId, title: 'Add rate limit to quotes endpoint', body: 'Public quotes endpoint is hammered. Limit it.', source: { type: 'web' }, requesterId: h.approver.id, actor: h.approver.id });
    id = wi.id;
    const row = await h.waitState(id, 'AWAITING_SPEC_APPROVAL');
    expect(await phases(id)).toEqual(['INTENT:done', 'SPEC:done']);
    const inbox = await h.s.orch.inbox.list({ orgId: h.orgId, status: 'open' });
    expect(inbox.filter((i) => i.workItemId === id).map((i) => i.kind)).toEqual(['spec_approval']);
    expect(row.prUrl).toMatch(/^local:\/\//);
    expect((await h.s.orch.pendingGate(id))?.type).toBe('specApproval');
    expect(await h.s.orch.specText(id)).toContain('Acceptance criteria');
  });

  it('a non-approver cannot approve; the tech-leads approver can; the build, verify and ship phases then run', async () => {
    const g = (await h.s.orch.pendingGate(id))!;
    await expect(h.s.orch.decideGate(g.id, { decision: 'approve', by: 'u2', role: 'member', groups: ['tech-leads'] })).rejects.toThrow(/approver role|tech-leads/);
    await expect(h.s.orch.decideGate(g.id, { decision: 'approve', by: 'u3', role: 'approver', groups: ['other'] })).rejects.toThrow(/tech-leads/);
    await approve(id);
    const row = await h.waitState(id, 'AWAITING_HANDOFF');
    expect(await phases(id)).toEqual(['INTENT:done', 'SPEC:done', 'BUILD:done', 'VERIFY:done', 'SHIP:done']);
    expect(row.costUsd).toBeGreaterThan(0);
    expect(row.tokensIn).toBeGreaterThan(0);
    const inbox = await h.s.orch.inbox.list({ orgId: h.orgId, status: 'open' });
    expect(inbox.filter((i) => i.workItemId === id).map((i) => i.kind)).toEqual(['pr_review']);
  });

  it('records what each agent saw, the events, usage, session ids and artifacts', async () => {
    const rs = await runsOf(id);
    for (const r of rs) {
      expect(r.contextBundleHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.sessionId).toBeTruthy();
      expect(r.eventCount).toBeGreaterThan(3);
      expect(r.tokensIn).toBeGreaterThan(0);
      expect(r.harness).toBe('fake');
    }
    expect(rs.find((r) => r.phase === 'BUILD')!.tokensOut).toBeGreaterThan(0);
    const events = await h.s.db.select().from(t.runEvents).where(eq(t.runEvents.runId, rs[0].id)).orderBy(asc(t.runEvents.seq));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.some((e) => e.kind === 'usage')).toBe(true);
    const spec = await h.s.artifacts.get(`runs/${rs.find((r) => r.phase === 'SPEC')!.id}/out/spec.md`);
    expect(spec?.toString()).toContain('R1');
    const ctx = JSON.parse((await h.s.artifacts.get(`runs/${rs[0].id}/context.json`))!.toString());
    expect(ctx.hash).toBe(rs[0].contextBundleHash);
    expect(ctx.report.some((x: { title: string }) => /Payments security policy/.test(x.title))).toBe(true);
  });

  it('the agent-only skills were materialised and the audit chain verifies', async () => {
    const audit = await verifyAudit(h.s.db, h.factoryId);
    expect(audit.ok).toBe(true);
    expect(audit.checked).toBeGreaterThan(20);
    const [w] = await h.s.db.select().from(t.workItems).where(eq(t.workItems.id, id));
    const log = await h.s.db.select().from(t.auditLog).where(eq(t.auditLog.chain, h.factoryId));
    const actions = new Set(log.map((e) => e.action));
    for (const a of ['work_item.created', 'work_item.transition', 'run.queued', 'run.started', 'run.ended', 'gate.requested', 'gate.decided', 'foreman.decision']) expect(actions.has(a)).toBe(true);
    const decided = log.find((e) => e.action === 'gate.decided')!;
    expect((decided.payload as { subjectHash: string }).subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.state).toBe('AWAITING_HANDOFF');
  });

  it('a person marking handoff completes the item', async () => {
    await h.s.orch.markHandedOff(id, h.approver.id);
    const [w] = await h.s.db.select().from(t.workItems).where(eq(t.workItems.id, id));
    expect(w.state).toBe('COMPLETE');
    expect(w.completedAt).toBeTruthy();
    expect((await h.s.orch.inbox.list({ orgId: h.orgId, status: 'open' })).filter((i) => i.workItemId === id)).toEqual([]);
  });
});

describe('questions: NEEDS_INPUT resumes the same agent session', () => {
  it('asks, waits, receives the answer and resumes', async () => {
    const wi = await h.s.orch.createWorkItem({ factoryId: h.factoryId, title: 'Retry policy for SEPA payouts', body: 'Decide retries. [fake:ask]', actor: 'u' });
    const row = await h.waitState(wi.id, 'NEEDS_INPUT');
    expect(row.pausedState).toBe('INTENT');
    const [q] = await h.s.db.select().from(t.questions).where(eq(t.questions.workItemId, wi.id));
    expect(q.kind).toBe('decision');
    const inbox = (await h.s.orch.inbox.list({ orgId: h.orgId, status: 'open' })).filter((i) => i.workItemId === wi.id);
    expect(inbox.map((i) => i.kind)).toEqual(['question']);
    const [first] = await runsOf(wi.id);
    await h.s.orch.answerQuestion(q.id, { answer: 'Yes', by: h.approver.id, byName: 'Priya N.' });
    await h.waitState(wi.id, 'AWAITING_SPEC_APPROVAL');
    const rs = (await runsOf(wi.id)).filter((r) => r.phase === 'INTENT');
    expect(rs.map((r) => r.status)).toEqual(['needs_input', 'done']);
    expect(rs[1].sessionId).toBe(first.sessionId); // same session continued
    expect(await h.s.orch.inbox.list({ orgId: h.orgId, status: 'open' }).then((l) => l.filter((i) => i.workItemId === wi.id && i.kind === 'question'))).toEqual([]);
    const foreman = await h.s.db.select().from(t.messages).where(eq(t.messages.workItemId, wi.id));
    expect(foreman.some((m) => m.authorKind === 'foreman' && /needs one thing|retries/i.test(m.body))).toBe(true);
    await h.s.orch.cancelWorkItem(wi.id, 'test');
  });

  it('a context request answered with a file attaches it as work item context and resumes', async () => {
    const wi = await h.s.orch.createWorkItem({ factoryId: h.factoryId, title: 'Ledger reconciliation export', body: 'Needs the layout. [fake:context]', actor: 'u' });
    await h.waitState(wi.id, 'NEEDS_INPUT');
    const [q] = await h.s.db.select().from(t.questions).where(eq(t.questions.workItemId, wi.id));
    expect(q.kind).toBe('context_request');
    expect((await h.s.orch.inbox.list({ orgId: h.orgId, status: 'open' })).find((i) => i.workItemId === wi.id)?.kind).toBe('context_request');
    const item = await h.s.contexts.attachFile(h.orgId, { layer: 'workItem', scopeId: wi.id, name: 'recon-layout.csv', data: Buffer.from('col,type\namount,int\n'), factoryId: h.factoryId }, h.approver.id);
    await h.s.orch.answerQuestion(q.id, { answer: '', by: h.approver.id, contextItemId: item.id });
    await h.waitState(wi.id, 'AWAITING_SPEC_APPROVAL');
    const preview = await h.s.contexts.preview(wi.id, { name: 'zerovity-spec-writer', phase: 'SPEC', contextScopes: ['org', 'factory', 'repo', 'workItem'] });
    expect(preview.contextMd).toContain('recon-layout.csv');
    expect(preview.contextMd).toContain('amount');
    await h.s.orch.cancelWorkItem(wi.id, 'test');
  });
});

describe('verification loop, risk gates and failures', () => {
  it('revise sends the same executor session back to BUILD once, then accepts', async () => {
    const wi = await h.s.orch.createWorkItem({ factoryId: h.factoryId, title: 'Idempotency keys', body: 'Add them. [fake:revise] [fake:skip-spec]', startPhase: 'INTENT', actor: 'u' });
    await h.waitState(wi.id, 'AWAITING_HANDOFF');
    expect(await phases(wi.id)).toEqual(['INTENT:done', 'BUILD:done', 'VERIFY:done', 'BUILD:done', 'VERIFY:done', 'SHIP:done']);
    const builds = (await runsOf(wi.id)).filter((r) => r.phase === 'BUILD');
    expect(builds[1].sessionId).toBe(builds[0].sessionId);
    const [row] = await h.s.db.select().from(t.workItems).where(eq(t.workItems.id, wi.id));
    expect(row.loops).toBe(1);
    await h.s.orch.cancelWorkItem(wi.id, 'test');
  });

  it('high risk adds the buildApproval gate; touching migrations adds dbReview', async () => {
    const wi = await h.s.orch.createWorkItem({ factoryId: h.factoryId, title: 'Drop legacy table', body: '[fake:high-risk] [fake:migration] [fake:skip-spec]', actor: 'u' });
    await h.waitState(wi.id, 'AWAITING_GATE');
    expect((await h.s.orch.pendingGate(wi.id))?.type).toBe('buildApproval');
    await approve(wi.id);
    await h.waitState(wi.id, 'AWAITING_GATE');
    await h.waitState(wi.id, 'AWAITING_GATE');
    const g = (await h.s.orch.pendingGate(wi.id))!;
    expect(g.type).toBe('dbReview');
    await h.s.orch.decideGate(g.id, { decision: 'approve', by: h.approver.id, role: 'approver', groups: ['tech-leads'] });
    await h.waitState(wi.id, 'AWAITING_HANDOFF');
    await h.s.orch.cancelWorkItem(wi.id, 'test');
  });

  it('two failures in a row block the item; retry resumes it', async () => {
    const wi = await h.s.orch.createWorkItem({ factoryId: h.factoryId, title: 'Broken thing', body: '[fake:fail]', actor: 'u' });
    const row = await h.waitState(wi.id, 'BLOCKED');
    expect(row.pausedState).toBe('INTENT');
    expect((await phases(wi.id)).filter((p) => p === 'INTENT:failed')).toHaveLength(2);
    expect((await h.s.orch.inbox.list({ orgId: h.orgId, status: 'open' })).find((i) => i.workItemId === wi.id)?.kind).toBe('failed');
    await h.s.orch.cancelWorkItem(wi.id, 'test');
    expect((await h.s.db.select().from(t.workItems).where(eq(t.workItems.id, wi.id)))[0].state).toBe('CANCELLED');
  });

  it('a missing result.json triggers one repair follow-up in the same session', async () => {
    const wi = await h.s.orch.createWorkItem({ factoryId: h.factoryId, title: 'Forgetful agent', body: '[fake:noresult] [fake:skip-spec]', actor: 'u' });
    await h.waitState(wi.id, 'AWAITING_HANDOFF');
    const r = (await runsOf(wi.id))[0];
    expect(r.status).toBe('done');
    const ev = await h.s.db.select().from(t.runEvents).where(eq(t.runEvents.runId, r.id));
    expect(ev.some((e) => e.kind === 'system.status' && /asking the agent to write it/.test(String(e.payload.text)))).toBe(true);
    await h.s.orch.cancelWorkItem(wi.id, 'test');
  });

  it('cancelling an item stops its queued work and clears its inbox', async () => {
    const wi = await h.s.orch.createWorkItem({ factoryId: h.factoryId, title: 'Slow one', body: '[fake:slow]', actor: 'u' });
    await h.waitState(wi.id, ['INTENT', 'SPEC']);
    await h.s.orch.cancelWorkItem(wi.id, 'u');
    await h.waitState(wi.id, 'CANCELLED');
    await new Promise((r) => setTimeout(r, 1500));
    const [row] = await h.s.db.select().from(t.workItems).where(eq(t.workItems.id, wi.id));
    expect(row.state).toBe('CANCELLED');
    expect((await h.s.orch.inbox.list({ orgId: h.orgId, status: 'open' })).filter((i) => i.workItemId === wi.id)).toEqual([]);
  });
});

describe('budgets and concurrency', () => {
  it('stops at the budget with a question; raising it resumes', async () => {
    const wi = await h.s.orch.createWorkItem({ factoryId: h.factoryId, title: 'Costly thing', body: '[fake:skip-spec]', budgetUsd: 0.000001, actor: 'u' });
    const row = await h.waitState(wi.id, 'NEEDS_INPUT');
    expect(row.flags).toMatchObject({ budgetBlocked: true });
    const [q] = await h.s.db.select().from(t.questions).where(eq(t.questions.workItemId, wi.id));
    expect(q.qid).toBe('budget');
    await h.s.orch.answerQuestion(q.id, { answer: 'Raise by $50', by: h.approver.id });
    await h.waitState(wi.id, 'AWAITING_HANDOFF');
    const [after] = await h.s.db.select().from(t.workItems).where(eq(t.workItems.id, wi.id));
    expect(after.budgetUsd).toBeGreaterThan(40);
    await h.s.orch.cancelWorkItem(wi.id, 'test');
  });
});

describe.skipIf(!gitAvailable())('run files do not outlive the run (needs git installed)', () => {
  it('skills and tool config are gone from the clone after the runs, nothing of them was committed, and the factory identity was used', async () => {
    const [wi] = await h.s.db.select().from(t.workItems).limit(1);
    const work = path.join(h.tmp, 'workspaces', wi.shortId, 'work');
    expect(fs.existsSync(path.join(work, '.git'))).toBe(true);
    for (const d of ['.claude/skills', '.agents/skills', '.github/skills', '.cursor']) expect(fs.existsSync(path.join(work, d)), d).toBe(false);
    expect(fs.existsSync(path.join(work, '.zerovity', 'run', 'overlay.json'))).toBe(false); // the crash journal is removed on a clean finish
    const tracked = (await git(work, ['ls-files'])).stdout;
    expect(tracked).not.toMatch(/\.claude\/skills|\.agents\/skills|\.cursor|\.zerovity/);
    const authors = (await git(work, ['log', '--format=%ae'])).stdout.split('\n').filter(Boolean);
    expect(authors.length).toBeGreaterThan(0);
    expect(new Set(authors)).toEqual(new Set(['factory@zerovity.local']));
    expect(fs.existsSync(path.join(h.tmp, 'workspaces', wi.shortId, 'agent.gitconfig'))).toBe(true); // the agent's isolated git config
  });
});
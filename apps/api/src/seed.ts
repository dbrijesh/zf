import { eq } from 'drizzle-orm';
import { ulid, slugify } from '@zerovity/core';
import { tables as t, nextShortId } from '@zerovity/db';
import { createFactory, ensureOrg, ensureUser, loadExample, type Services } from '@zerovity/orchestrator';

/** deterministic PRNG so seeded dashboards are stable */
export function rng(seed = 7) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

const TITLES = ['Retry policy for failed SEPA payouts', 'Rate limit the public quotes endpoint', 'Flaky test in ledger close-of-day job', 'Ledger reconciliation export for finance', 'Add idempotency keys to payout API', 'Two-step approval for refunds over $10k', 'Migrate card vault client to v3 SDK', 'Currency rounding in multi-leg FX quotes', 'Audit trail for manual ledger adjustments', 'Webhook signature check for PSP callbacks', 'Daily settlement report: timezone fix', 'Expose payout status over gRPC', 'Remove deprecated v1 webhook route', 'Fix N+1 query in statement export', 'Add PII masking to support logs', 'Backfill missing FX rates for March', 'Paginate the merchant transactions list', 'Return 409 on duplicate refund requests', 'Cache FX quotes for 30 seconds', 'Normalise IBAN input before validation'];
const HARNESS: Record<string, { harness: string; model: string; agent: string }> = {
  INTENT: { harness: 'claude-code', model: 'claude-sonnet-5-5', agent: 'zerovity-researcher' }, SPEC: { harness: 'claude-code', model: 'claude-sonnet-5-5', agent: 'zerovity-spec-writer' }, BUILD: { harness: 'codex', model: 'gpt-5-codex', agent: 'zerovity-executor' },
  VERIFY: { harness: 'copilot', model: 'claude-sonnet-5-5', agent: 'zerovity-verifier' }, SHIP: { harness: 'claude-code', model: 'claude-haiku-5-5', agent: 'zerovity-shipper' },
};
const MEDIAN: Record<string, number> = { INTENT: 9, SPEC: 22, BUILD: 31, VERIFY: 17, SHIP: 6 };

export interface DemoOptions { dataFactoryName?: string; withLive?: boolean; historyDays?: number }

/** An org, three people, one factory from example 02, and (optionally) live work items driven by the fake harness. */
export async function seedDemo(s: Services, o: DemoOptions = {}) {
  const org = await ensureOrg(s.db, 'Acme', 'default');
  const admin = await ensureUser(s.db, org.id, { email: 'admin@acme.test', name: 'Ada Admin', role: 'org_admin' });
  const priya = await ensureUser(s.db, org.id, { email: 'priya@acme.test', name: 'Priya N.', role: 'approver', groups: ['tech-leads'] });
  await ensureUser(s.db, org.id, { email: 'dev@acme.test', name: 'Dev Dana', role: 'member' });
  await ensureUser(s.db, org.id, { email: 'viewer@acme.test', name: 'Vic Viewer', role: 'viewer' });
  const [existing] = await s.db.select().from(t.factories).where(eq(t.factories.name, 'payments-factory'));
  if (existing) return { orgId: org.id, factoryId: existing.id, adminId: admin.id, approverId: priya.id, created: false };
  const files = loadExample(s.repoRoot, '02-issue-to-pr');
  const { factoryId, apply } = await createFactory(s, { orgId: org.id, files, by: admin.id, message: 'Seed: payments factory' });
  if (!apply.ok) throw new Error('seed definition invalid: ' + JSON.stringify(apply.issues.filter((i) => i.severity === 'error')));
  await s.secrets.set('org', org.id, 'JIRA_MCP_TOKEN', 'demo-token-not-real', admin.id);
  await seedHistory(s, factoryId, o.historyDays ?? 14);
  if (o.withLive !== false) await seedLive(s, factoryId, admin.id);
  return { orgId: org.id, factoryId, adminId: admin.id, approverId: priya.id, created: true };
}

/** Real work items that the worker will drive (needs the fake harness): some run, one asks, one reaches the spec gate. */
export async function seedLive(s: Services, factoryId: string, by: string) {
  const mk = (title: string, body: string, extra: Record<string, unknown> = {}) => s.orch.createWorkItem({ factoryId, title, body, actor: by, source: { type: Math.random() > 0.5 ? 'github' : 'jira', ref: `demo-${slugify(title, 20)}` }, ...extra } as never);
  await mk(TITLES[0], 'Should retries stop after the bank returns AC04? [fake:ask] [fake:slow]');
  await mk(TITLES[1], 'The quotes endpoint is hammered by a partner. [fake:slow]');
  await mk(TITLES[3], 'Needs the layout from finance. [fake:context]');
  await mk(TITLES[5], 'Second approver from finance-ops for refunds over $10k. [fake:high-risk]');
}

/** Backdated completed work for the dashboard: cycle times, costs, gate waits, loops, scorer results. */
export async function seedHistory(s: Services, factoryId: string, days = 14, n = 26) {
  const r = rng(11);
  const now = Date.now();
  const [f] = await s.db.select().from(t.factories).where(eq(t.factories.id, factoryId));
  const [spec] = await s.db.select().from(t.scorers).where(eq(t.scorers.factoryId, factoryId));
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(now - (days * 86_400_000 * (i + r())) / n);
    const { shortId, seq } = await nextShortId(s.db, factoryId);
    const id = ulid();
    const loops = r() < 0.25 ? 1 : r() < 0.05 ? 2 : 0;
    let t0 = createdAt.getTime();
    let total = 0, tin = 0, tout = 0;
    const title = TITLES[i % TITLES.length];
    const runRows: Array<typeof t.runs.$inferInsert> = [];
    const phases = ['INTENT', 'SPEC', 'BUILD', 'VERIFY', ...(loops ? ['BUILD', 'VERIFY'] : []), 'SHIP'] as const;
    let gateWait = 0;
    for (const ph of phases) {
      const h = HARNESS[ph];
      const dur = Math.max(2, MEDIAN[ph] * (0.6 + r() * 0.9));
      const input = Math.round(40_000 + r() * 160_000), output = Math.round(3_000 + r() * 22_000);
      const cost = h.harness === 'copilot' ? 0.04 : Number(((input * 3 + output * 15) / 1e6 * (h.harness === 'codex' ? 0.6 : ph === 'SHIP' ? 0.3 : 1)).toFixed(4));
      const start = t0, end = t0 + dur * 60_000;
      runRows.push({ id: ulid(), workItemId: id, factoryId, agentName: h.agent, phase: ph, harness: h.harness, model: h.model, sessionId: `seed-${id.slice(-6)}-${ph}`, runner: 'node-default', status: 'done', startedAt: new Date(start), endedAt: new Date(end), tokensIn: input, tokensOut: output, tokensCached: Math.round(input * 0.4), costUsd: cost, premiumRequests: h.harness === 'copilot' ? 1 : null, eventCount: 0, resultJson: { status: 'done', summary: `${h.agent} finished ${ph}.`, questions: [], artifacts: [], evidence: [], findings: [], pathsTouched: [] } as never, createdAt: new Date(start), updatedAt: new Date(end) });
      total += cost; tin += input; tout += output;
      t0 = end;
      if (ph === 'SPEC') { gateWait = 8 + r() * 140; t0 += gateWait * 60_000; }
    }
    await s.db.insert(t.workItems).values({ id, factoryId, shortId, seq, title, body: 'Seeded history item.', sourceType: r() > 0.5 ? 'github' : 'jira', sourceRef: `seed-${i}`, state: 'COMPLETE', phase: 'SHIP', branch: `zerovity/${shortId.toLowerCase()}-${slugify(title, 24)}`, prUrl: `local://acme/payments-service/pull/${100 + i}`, prNumber: 100 + i, loops, costUsd: total, tokensIn: tin, tokensOut: tout, budgetUsd: 25, stateSince: new Date(t0), completedAt: new Date(t0), createdAt, updatedAt: new Date(t0), flags: r() < 0.12 ? { humanCommits: true } : {} });
    await s.db.insert(t.runs).values(runRows);
    await s.db.insert(t.gates).values({ id: ulid(), workItemId: id, type: 'specApproval', status: 'approved', subjectHash: ulid().toLowerCase().padEnd(64, '0'), requestedAt: new Date(createdAt.getTime() + 31 * 60_000), decidedBy: 'Priya N.', decidedAt: new Date(createdAt.getTime() + (31 + gateWait) * 60_000), reason: 'matches finance-ops policy' });
    const specRun = runRows.find((x) => x.phase === 'SPEC');
    if (spec && specRun && r() < 0.8) {
      const lab = r() < 0.7 ? 'pass' : r() < 0.7 ? 'partial' : 'fail';
      await s.db.insert(t.scores).values({ id: ulid(), runId: specRun.id!, scorerId: spec.id, label: lab, score: lab === 'pass' ? 1 : lab === 'partial' ? 0.5 : 0.1, rationale: lab === 'pass' ? 'Every requirement has a numbered acceptance criterion.' : lab === 'partial' ? '3 requirements but 2 acceptance criteria.' : 'No numbered requirements.', judge: 'heuristic', createdAt: new Date(specRun.endedAt!) });
    }
  }
  void f;
}

/** Many open items spread over the lanes, for the 200-item floor test (spec 12.2). Rows only; nothing runs. */
export async function seedBulkItems(s: Services, factoryId: string, count = 200) {
  const r = rng(3);
  const states = ['INTENT', 'SPEC', 'AWAITING_SPEC_APPROVAL', 'BUILD', 'VERIFY', 'SHIP', 'NEEDS_INPUT', 'AWAITING_HANDOFF'] as const;
  for (let i = 0; i < count; i++) {
    const state = states[Math.floor(r() * states.length)];
    const { shortId, seq } = await nextShortId(s.db, factoryId);
    const cost = Number((r() * 9).toFixed(2));
    await s.db.insert(t.workItems).values({ id: ulid(), factoryId, shortId, seq, title: `${TITLES[i % TITLES.length]} (${i + 1})`, body: '', sourceType: r() > 0.5 ? 'github' : 'jira', state, phase: ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'].includes(state) ? state : null, pausedState: state === 'NEEDS_INPUT' ? 'INTENT' : null, gate: state === 'AWAITING_SPEC_APPROVAL' ? 'specApproval' : null, costUsd: cost, budgetUsd: 25, loops: r() < 0.1 ? 1 : 0, createdAt: new Date(Date.now() - Math.floor(r() * 5 * 3600_000)), stateSince: new Date(Date.now() - Math.floor(r() * 3600_000)) });
  }
}

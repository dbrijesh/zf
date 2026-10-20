import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createServices, findRepoRoot, RuleAdvisor, type Services } from '@zerovity/orchestrator';
import { tables as t } from '@zerovity/db';
import { ulid } from '@zerovity/core';
import { Worker } from '@zerovity/worker';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { seedDemo, seedBulkItems } from '../src/seed';
import type { AppCtx } from '../src/context';

const ROOT = findRepoRoot(import.meta.dirname);
let s: Services, app: FastifyInstance, ctx: AppCtx, w: Worker, tmp: string, factoryId: string;
let adminCookie = '', priyaCookie = '', devCookie = '', viewerCookie = '';

const call = async (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  let json: any; try { json = r.json(); } catch { json = undefined; }  
  return { status: r.statusCode, json, raw: r.body, headers: r.headers };
};
const login = async (email: string) => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', payload: { email } });
  expect(r.statusCode).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
};
const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 40_000): Promise<T> => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-api-'));
  s = await createServices({ memory: true, dataDir: tmp, forceHarness: 'fake', advisor: new RuleAdvisor(), repoRoot: ROOT, masterKey: Buffer.alloc(32, 9), log: { info() {}, warn() {}, error() {}, child() { return this; } } as never });
  ({ app, ctx } = await buildApp({ services: s, cfg: { devLogin: true, publicUrl: 'http://localhost:8787', webDist: '/nonexistent' } }));
  // first dev login of a fresh install becomes org admin
  adminCookie = await login('admin@acme.test');
  const seeded = await seedDemo(s, { withLive: false });
  factoryId = seeded.factoryId;
  priyaCookie = await login('priya@acme.test');
  devCookie = await login('dev@acme.test');
  viewerCookie = await login('viewer@acme.test');
  w = new Worker(s, { concurrency: 3, pollMs: 40, sandbox: 'local', maintenance: false, forges: ctx.forges });
  await w.start();
}, 120_000);
afterAll(async () => { await w?.stop(5000); await app?.close(); await s?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('auth and roles', () => {
  it('rejects anonymous calls but serves health and schemas publicly', async () => {
    expect((await call('', 'GET', '/factories')).status).toBe(401);
    expect((await call('', 'GET', '/health')).json.ok).toBe(true);
    const sc = await call('', 'GET', '/schemas/zf/v1alpha1/factory.json');
    expect(sc.status).toBe(200);
    expect(sc.json.$id).toContain('factory');
    expect((await call('', 'GET', '/schemas/zf/v1alpha1/nope.json')).status).toBe(404);
  });
  it('exposes the OpenAPI document generated from the zod schemas', async () => {
    const r = await call('', 'GET', '/openapi.json');
    expect(r.json.openapi).toMatch(/^3\./);
    expect(Object.keys(r.json.paths)).toEqual(expect.arrayContaining(['/api/v1/work-items', '/api/v1/inbox', '/api/v1/factories/{id}/floor']));
  });
  it('the first user is an org admin; later users are members unless seeded', async () => {
    expect((await call(adminCookie, 'GET', '/me')).json.role).toBe('org_admin');
    const me = (await call(priyaCookie, 'GET', '/me')).json;
    expect(me).toMatchObject({ role: 'approver', groups: ['tech-leads'] });
    expect((await call(viewerCookie, 'GET', '/me')).json.role).toBe('viewer');
  });
  it('viewers cannot create work items; members can', async () => {
    const body = { factoryId, title: 'A thing to build' };
    expect((await call(viewerCookie, 'POST', '/work-items', body)).status).toBe(403);
    expect((await call(devCookie, 'POST', '/work-items', { ...body, body: '[fake:skip-spec] [fake:ask]' })).status).toBe(200);
  });
  it('personal access tokens authenticate and can be revoked', async () => {
    const tok = (await call(devCookie, 'POST', '/tokens', { name: 'laptop' })).json;
    expect(tok.token).toMatch(/^zfp_/);
    const viaPat = await call('', 'GET', '/me', undefined, { authorization: `Bearer ${tok.token}` });
    expect(viaPat.json.email).toBe('dev@acme.test');
    expect(JSON.stringify((await call(devCookie, 'GET', '/tokens')).json)).not.toContain(tok.token);
    await call(devCookie, 'DELETE', `/tokens/${tok.id}`);
    expect((await call('', 'GET', '/me', undefined, { authorization: `Bearer ${tok.token}` })).status).toBe(401);
  });
  it('tampered session cookies are rejected', async () => {
    expect((await call(adminCookie.slice(0, -3) + 'xyz', 'GET', '/me')).status).toBe(401);
  });
  it('validation errors are 400 with details; unknown ids are 404', async () => {
    const r = await call(devCookie, 'POST', '/work-items', { factoryId, title: 'x' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid');
    expect((await call(devCookie, 'GET', '/work-items/nope')).status).toBe(404);
  });
});

describe('the whole flow over HTTP', () => {
  let id: string;
  it('creates an item with attached context and watches it reach the spec gate', async () => {
    const r = await call(devCookie, 'POST', '/work-items', { factoryId, title: 'Two-step approval for refunds', body: 'Refunds over $10k need a second approver.', context: [{ title: 'Finance note', body: 'Second approver is from finance-ops.', kind: 'note' }] });
    expect(r.status).toBe(200);
    id = r.json.id;
    expect(r.json.shortId).toMatch(/^ZF-\d+$/);
    await waitFor(async () => (await call(devCookie, 'GET', `/work-items/${id}`)).json.workItem.state === 'AWAITING_SPEC_APPROVAL');
    const d = (await call(devCookie, 'GET', `/work-items/${id}`)).json;
    expect(d.timeline.filter((x: { kind: string }) => x.kind === 'run')).toHaveLength(2);
    expect(d.pendingGate.type).toBe('specApproval');
    expect(d.audit.verified.ok).toBe(true);
  });
  it('shows the spec, the gate in the inbox and the "what the agent sees" preview with the attached note', async () => {
    expect((await call(devCookie, 'GET', `/work-items/${id}/spec`)).json.text).toContain('Acceptance criteria');
    const inbox = (await call(priyaCookie, 'GET', '/inbox')).json;
    const item = inbox.find((i: { workItemId: string; kind: string }) => i.workItemId === id && i.kind === 'spec_approval');
    expect(item).toBeTruthy();
    expect((await call(priyaCookie, 'GET', '/inbox/counts')).json.open).toBeGreaterThan(0);
    const detail = (await call(priyaCookie, 'GET', `/inbox/${item.id}`)).json;
    expect(detail.spec).toContain('R1');
    const prev = (await call(devCookie, 'GET', `/work-items/${id}/context/preview?agent=zerovity-executor&phase=BUILD`)).json;
    expect(prev.contextMd).toContain('Finance note');
    expect(prev.report.some((r: { title: string; tokens: number }) => r.title === 'Finance note' && r.tokens > 0)).toBe(true);
    const off = prev.report.find((r: { title: string }) => r.title === 'Finance note');
    await call(devCookie, 'PUT', `/work-items/${id}/context/toggles`, { itemId: off.id, enabled: false });
    expect((await call(devCookie, 'GET', `/work-items/${id}/context/preview?agent=zerovity-executor&phase=BUILD`)).json.contextMd).not.toContain('Second approver is from finance-ops');
    await call(devCookie, 'PUT', `/work-items/${id}/context/toggles`, { itemId: off.id, enabled: true });
  });
  it('members cannot approve; the tech-leads approver can; the item reaches handoff', async () => {
    const gate = (await call(devCookie, 'GET', `/work-items/${id}`)).json.pendingGate;
    expect((await call(devCookie, 'POST', `/gates/${gate.id}/decision`, { decision: 'approve' })).status).toBe(403);
    expect((await call(priyaCookie, 'POST', `/gates/${gate.id}/decision`, { decision: 'approve', reason: 'ok' })).status).toBe(200);
    await waitFor(async () => (await call(devCookie, 'GET', `/work-items/${id}`)).json.workItem.state === 'AWAITING_HANDOFF');
    const d = (await call(devCookie, 'GET', `/work-items/${id}`)).json;
    expect(d.workItem.costUsd).toBeGreaterThan(0);
    expect(d.gates[0]).toMatchObject({ status: 'approved', decidedBy: 'Priya N.' });
  });
  it('serves changes, evidence, artifacts, run events, transcripts, usage and the audit export', async () => {
    const d = (await call(devCookie, 'GET', `/work-items/${id}`)).json;
    const build = d.runs.find((r: { phase: string }) => r.phase === 'BUILD');
    const ev = (await call(devCookie, 'GET', `/work-items/${id}/evidence`)).json;
    expect(ev.evidence.length).toBeGreaterThan(0);
    expect(ev.files.map((f: { name: string }) => f.name)).toContain('evidence.md');
    const art = await call(devCookie, 'GET', `/artifacts?runId=${build.id}&name=evidence.md`);
    expect(art.raw).toContain('Evidence');
    expect(art.headers['x-content-type-options']).toBe('nosniff');
    expect((await call(devCookie, 'GET', `/artifacts?runId=${build.id}&name=../../x`)).status).toBe(400);
    const events = (await call(devCookie, 'GET', `/runs/${build.id}/events?after=2`)).json;
    expect(events[0].seq).toBe(3);
    const tr = await call(devCookie, 'GET', `/runs/${build.id}/transcript`);
    expect(tr.raw.trim().split('\n').length).toBeGreaterThan(3);
    expect((await call(devCookie, 'GET', `/runs/${build.id}/context`)).json.hash).toBe(build.contextBundleHash);
    expect((await call(devCookie, 'GET', `/factories/${factoryId}/usage?by=harness&days=1`)).json.length).toBeGreaterThan(0);
    const csv = await call(devCookie, 'GET', `/factories/${factoryId}/usage.csv?by=agent&days=1`);
    expect(csv.raw.split('\n')[0]).toContain('cost_usd');
    expect((await call(devCookie, 'GET', `/factories/${factoryId}/audit/export?format=csv`)).status).toBe(403); // approver+
    const aud = await call(priyaCookie, 'GET', `/factories/${factoryId}/audit/export?format=jsonl`);
    expect(aud.raw.trim().split('\n').length).toBeGreaterThan(10);
    expect((await call(devCookie, 'GET', `/factories/${factoryId}/audit/verify`)).json.ok).toBe(true);
  });
  it('a person marks the handoff and the item completes', async () => {
    expect((await call(devCookie, 'POST', `/work-items/${id}/handoff`)).status).toBe(200);
    expect((await call(devCookie, 'GET', `/work-items/${id}`)).json.workItem.state).toBe('COMPLETE');
  });
});

describe('questions and context requests over HTTP', () => {
  it('answers a decision question with a button value and a context request with an uploaded file', async () => {
    const a = (await call(devCookie, 'POST', '/work-items', { factoryId, title: 'SEPA retry policy', body: 'Decide. [fake:ask]' })).json;
    await waitFor(async () => (await call(devCookie, 'GET', `/work-items/${a.id}`)).json.workItem.state === 'NEEDS_INPUT');
    const q = (await call(devCookie, 'GET', `/work-items/${a.id}`)).json.questions[0];
    expect((await call(devCookie, 'POST', `/questions/${q.id}/answer`, { answer: 'Stop on AC04' })).json.answer).toBe('Stop on AC04');
    expect((await call(devCookie, 'POST', `/questions/${q.id}/answer`, { answer: 'again' })).status).toBe(409);
    await waitFor(async () => (await call(devCookie, 'GET', `/work-items/${a.id}`)).json.workItem.state === 'AWAITING_SPEC_APPROVAL');

    const b = (await call(devCookie, 'POST', '/work-items', { factoryId, title: 'Recon export layout', body: 'Needs a file. [fake:context]' })).json;
    await waitFor(async () => (await call(devCookie, 'GET', `/work-items/${b.id}`)).json.workItem.state === 'NEEDS_INPUT');
    const cq = (await call(devCookie, 'GET', `/work-items/${b.id}`)).json.questions[0];
    expect(cq.kind).toBe('context_request');
    const boundary = '----zf' + crypto.randomBytes(6).toString('hex');
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recon-layout.csv"\r\nContent-Type: text/csv\r\n\r\ncolumn,type\r\namount,int\r\n--${boundary}--\r\n`;
    const up = await app.inject({ method: 'POST', url: `/api/v1/questions/${cq.id}/answer-file`, payload, headers: { cookie: devCookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode).toBe(200);
    await waitFor(async () => (await call(devCookie, 'GET', `/work-items/${b.id}`)).json.workItem.state === 'AWAITING_SPEC_APPROVAL');
    const lib = (await call(devCookie, 'GET', `/context?workItemId=${b.id}&layer=workItem`)).json;
    expect(lib.some((c: { title: string }) => c.title === 'recon-layout.csv')).toBe(true);
  });
  it('cancelling clears the inbox', async () => {
    const c = (await call(devCookie, 'POST', '/work-items', { factoryId, title: 'Will be cancelled', body: '[fake:ask]' })).json;
    await waitFor(async () => (await call(devCookie, 'GET', `/work-items/${c.id}`)).json.workItem.state === 'NEEDS_INPUT');
    await call(devCookie, 'POST', `/work-items/${c.id}/cancel`);
    expect((await call(devCookie, 'GET', '/inbox')).json.filter((i: { workItemId: string }) => i.workItemId === c.id)).toEqual([]);
  });
});

describe('studio: agents, skills, context library, definition', () => {
  it('lists agents with effective skills, layers, weight and stats', async () => {
    const list = (await call(devCookie, 'GET', `/factories/${factoryId}/agents`)).json;
    const ex = list.find((a: { name: string }) => a.name === 'zerovity-executor');
    expect(ex.skills.map((x: { name: string; layer: string }) => `${x.name}:${x.layer}`)).toContain('zerovity-tdd-loop:pack');
    expect(ex.weight.total).toBeGreaterThan(50);
    expect(list.find((a: { name: string }) => a.name === 'acme-api-reviewer').skills.map((x: { layer: string }) => x.layer)).toContain('agent');
  });
  it('changing an agent harness writes an override and the next run uses it', async () => {
    const r = await call(priyaCookie, 'PUT', `/factories/${factoryId}/agents/zerovity-verifier`, { harness: { type: 'codex', model: 'gpt-5-codex' } });
    expect(r.status).toBe(403); // approvers cannot edit agents
    const ok = await call(adminCookie, 'PUT', `/factories/${factoryId}/agents/zerovity-verifier`, { harness: { type: 'codex', model: 'gpt-5-codex' }, runner: 'node-default' });
    expect(ok.json.ok).toBe(true);
    const a = (await call(devCookie, 'GET', `/factories/${factoryId}/agents/zerovity-verifier`)).json;
    expect(a.harness).toMatchObject({ type: 'codex', model: 'gpt-5-codex' });
    expect(a.effectiveHarness).toBe('fake'); // this suite forces the offline harness
    expect(a.overridden).toContain('harness');
    expect(await ctx.s.defs.getActive(factoryId).then((x) => ctx.s.defs.effectiveHarness(x!, x!.agents.get('zerovity-verifier')!, null).type)).toBe('codex');
    await call(adminCookie, 'PUT', `/factories/${factoryId}/agents/zerovity-verifier`, { harness: { type: 'copilot' } });
  });
  it('edits a factory skill with live lint, token counts, and rejects a heavy skill', async () => {
    const good = `---\nname: acme-glossary\ndescription: Look up Acme payments terms. Use when a term is unfamiliar.\nzerovity:\n  version: 1.1.0\n---\n\n# Glossary\n\n- Payout: money to merchants.\n`;
    const lintRes = (await call(devCookie, 'POST', '/skills/lint', { name: 'acme-glossary', files: { 'SKILL.md': good } })).json;
    expect(lintRes.issues.filter((i: { severity: string }) => i.severity === 'error')).toEqual([]);
    expect(lintRes.tokens.body).toBeGreaterThan(0);
    const heavy = good + 'line\n'.repeat(200);
    expect((await call(devCookie, 'POST', '/skills/lint', { name: 'acme-glossary', files: { 'SKILL.md': heavy } })).json.issues.map((i: { code: string }) => i.code)).toContain('skill_body_lines');
    const bad = await call(adminCookie, 'PUT', `/factories/${factoryId}/skills/acme-glossary`, { files: { 'SKILL.md': heavy } });
    expect(bad.json.ok).toBe(false);
    const saved = await call(adminCookie, 'PUT', `/factories/${factoryId}/skills/acme-glossary`, { files: { 'SKILL.md': good } });
    expect(saved.json.ok).toBe(true);
    const lib = (await call(devCookie, 'GET', `/factories/${factoryId}/skills`)).json;
    expect(lib.skills.find((x: { name: string; scope: string }) => x.name === 'acme-glossary' && x.scope === 'factory').version).toBe('1.1.0');
    expect(lib.skills.some((x: { scope: string }) => x.scope === 'pack')).toBe(true);
  });
  it('forks a pack skill into the factory; pack skills are read-only', async () => {
    expect((await call(adminCookie, 'PUT', `/factories/${factoryId}/skills/zerovity-repro`, { scope: 'pack:zerovity-core', files: {} })).status).toBe(400);
    const f = await call(adminCookie, 'POST', `/factories/${factoryId}/skills/zerovity-repro/fork`, { from: 'pack:zerovity-core' });
    expect(f.json.ok).toBe(true);
    const lib = (await call(devCookie, 'GET', `/factories/${factoryId}/skills`)).json;
    expect(lib.skills.filter((x: { name: string }) => x.name === 'zerovity-repro').map((x: { scope: string }) => x.scope).sort()).toEqual(['factory', 'pack']);
  });
  it('context library: create, search, version, restore, URL snapshot guard', async () => {
    const c = (await call(adminCookie, 'POST', '/context', { layer: 'factory', scopeId: factoryId, title: 'Ledger glossary', body: 'Settlement: daily reconciliation.', tags: ['domain'], kind: 'note' })).json;
    expect((await call(devCookie, 'GET', '/context?factoryId=' + factoryId + '&q=settlement')).json.map((x: { id: string }) => x.id)).toContain(c.id);
    expect((await call(devCookie, 'GET', '/context?factoryId=' + factoryId + '&tag=domain')).json.length).toBeGreaterThan(0);
    await call(adminCookie, 'PATCH', `/context/${c.id}`, { body: 'Settlement: daily reconciliation of PSP reports.' });
    const vers = (await call(devCookie, 'GET', `/context/${c.id}/versions`)).json;
    expect(vers.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    await call(adminCookie, 'POST', `/context/${c.id}/restore`, { version: 1 });
    expect((await call(devCookie, 'GET', `/context/${c.id}`)).json.body).toBe('Settlement: daily reconciliation.');
    expect((await call(devCookie, 'POST', '/context', { layer: 'org', title: 'x', body: 'y' })).status).toBe(403);
    expect((await call(adminCookie, 'POST', '/context/url', { layer: 'factory', scopeId: factoryId, url: 'http://169.254.169.254/latest/meta-data' })).status).toBe(400);
    await call(adminCookie, 'DELETE', `/context/${c.id}`);
    expect((await call(devCookie, 'GET', `/context/${c.id}`)).status).toBe(404);
  });
  it('definition: validate shows file and line; invalid saves are rejected and keep the last valid version', async () => {
    const before = (await call(devCookie, 'GET', `/factories/${factoryId}/definition`)).json;
    const v = (await call(devCookie, 'POST', `/factories/${factoryId}/definition/validate`, { files: { 'zerovity.factory.yaml': 'schemaVersion: zf/v1alpha1\nname: payments-factory\nbogus: 1\n' } })).json;
    expect(v.ok).toBe(false);
    expect(v.issues.find((i: { code: string }) => i.code === 'unknown_key')).toMatchObject({ file: 'zerovity.factory.yaml', line: 3 });
    const bad = await call(adminCookie, 'PUT', `/factories/${factoryId}/definition`, { files: { 'zerovity.factory.yaml': 'name: broken' }, message: 'oops' });
    expect(bad.json.applied).toBe(false);
    const after = (await call(devCookie, 'GET', `/factories/${factoryId}/definition`)).json;
    expect(after.commit).toBe(before.commit);
    expect(after.latestValid).toBe(false);
    const ok = await call(adminCookie, 'PUT', `/factories/${factoryId}/definition`, { files: { 'context/extra.md': '---\ntitle: Extra\nlayer: factory\n---\nHello\n' }, message: 'add context file' });
    expect(ok.json.applied).toBe(true);
    expect((await call(devCookie, 'GET', `/context?factoryId=${factoryId}&q=Extra`)).json.length).toBe(1);
    const hist = (await call(devCookie, 'GET', `/factories/${factoryId}/definition`)).json.history;
    expect(hist[0].message).toBe('add context file');
    const rb = await call(adminCookie, 'POST', `/factories/${factoryId}/definition/rollback`, { commit: before.commit });
    expect(rb.json.ok).toBe(true);
  });
});

describe('measure, settings, secrets, connections, webhooks, floor', () => {
  it('dashboard renders every metric from seeded history', async () => {
    const d = (await call(devCookie, 'GET', `/factories/${factoryId}/dashboard?days=30`)).json;
    expect(d.completed).toBeGreaterThan(10);
    expect(d.cycleTimeByPhase.every((p: { n: number }) => p.n > 0)).toBe(true);
    expect(d.costPerCompleted).toBeGreaterThan(0);
    expect(d.tokensByHarness.map((x: { harness: string }) => x.harness)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'copilot']));
    expect(d.autonomyRate).toBeGreaterThan(0.5);
    expect(d.gateWaitMedianMin).toBeGreaterThan(0);
    expect(d.scorerPassRates[0].total).toBeGreaterThan(0);
    expect(d.daily.length).toBeGreaterThanOrEqual(29);
    expect(d.revisionHistogram['0']).toBeGreaterThan(0);
  });
  it('scorers: create, run against a run, see results', async () => {
    const put = await call(adminCookie, 'PUT', `/factories/${factoryId}/scorers/summary-present`, { rubric: 'Pass when the run wrote a summary.', labels: ['pass', 'fail'], passLabels: ['pass'], sampling: 1 });
    expect(put.status).toBe(200);
    const run = (await call(devCookie, 'GET', `/runs?factoryId=${factoryId}&status=done&limit=1`)).json[0];
    expect((await call(devCookie, 'POST', `/runs/${run.id}/score`, {})).json.scored).toBeGreaterThan(0);
    expect((await call(devCookie, 'GET', `/factories/${factoryId}/scores`)).json.some((x: { scorer: string }) => x.scorer === 'summary-present')).toBe(true);
  });
  it('secrets are write-only: only names and last four characters come back', async () => {
    await call(adminCookie, 'PUT', '/secrets/ANTHROPIC_API_KEY', { value: 'sk-ant-test-abcdefghij1234' });
    const list = (await call(adminCookie, 'GET', '/secrets')).json;
    expect(JSON.stringify(list)).not.toContain('sk-ant');
    expect(list.find((x: { name: string }) => x.name === 'ANTHROPIC_API_KEY').last4).toBe('1234');
    expect((await call(devCookie, 'GET', '/secrets')).status).toBe(403);
  });
  it('connections: catalogue, create with a masked secret, test (real call), rotate, dependents, delete', async () => {
    expect((await call(devCookie, 'GET', '/connections/catalogue')).json.some((c: { id: string; v1: boolean }) => c.id === 'jira-cloud' && c.v1)).toBe(true);
    expect((await call(devCookie, 'POST', '/connections', { typeId: 'openai', displayName: 'x', values: { api_key: 'k' } })).status).toBe(403);
    ctx.conns['o'].fetchImpl = (async (url: string) => new Response(JSON.stringify({ data: [] }), { status: String(url).includes('/models') ? 200 : 404 })) as typeof fetch;
    const c = (await call(adminCookie, 'POST', '/connections', { typeId: 'openai', displayName: 'team-openai', values: { api_key: 'sk-test-0000aaaa' } })).json;
    expect(c.status).toBe('connected');
    expect(c.secrets).toEqual([{ name: 'api_key', last4: 'aaaa' }]);
    expect(JSON.stringify(c)).not.toContain('sk-test');
    await call(adminCookie, 'PUT', `/factories/${factoryId}/agents/zerovity-executor/assignment`, { credential: 'team-openai' });
    const del = (await call(adminCookie, 'DELETE', `/connections/${c.id}`)).json;
    expect(del.removed).toBe(false);
    expect(del.dependents.agents).toEqual([{ factory: 'payments-factory', agent: 'zerovity-executor' }]);
    ctx.conns['o'].fetchImpl = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    const t2 = (await call(adminCookie, 'POST', `/connections/${c.id}/test`)).json;
    expect(t2.status).toBe('expired');
    const inbox = (await call(adminCookie, 'GET', '/inbox?kind=connection')).json;
    expect(inbox.some((i: { title: string }) => i.title.includes('team-openai'))).toBe(true); // raised within one check cycle
    ctx.conns['o'].fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const rot = (await call(adminCookie, 'POST', `/connections/${c.id}/rotate`, { values: { api_key: 'sk-new-0000bbbb' } })).json;
    expect(rot.status).toBe('connected');
    expect((await call(adminCookie, 'GET', '/inbox?kind=connection')).json.some((i: { title: string }) => i.title.includes('team-openai'))).toBe(false);
    await call(adminCookie, 'PUT', `/factories/${factoryId}/agents/zerovity-executor/assignment`, { credential: null });
    expect((await call(adminCookie, 'DELETE', `/connections/${c.id}`)).json.removed).toBe(true);
    ctx.conns['o'].fetchImpl = undefined;
  });
  it('settings: model prices and factory budgets', async () => {
    await call(adminCookie, 'PUT', '/settings/prices', { model: 'claude-sonnet-5-5', inputPerMtok: 3.5, outputPerMtok: 16, cachedPerMtok: 0.35 });
    expect((await call(devCookie, 'GET', '/settings/prices')).json[0].inputPerMtok).toBe(3.5);
    const r = await call(adminCookie, 'PUT', `/factories/${factoryId}/settings`, { limits: { maxConcurrentRuns: 6, maxRunsPerRepo: 3 }, budget: { maxCostPerWorkItemUsd: 40 } });
    expect(r.json.ok).toBe(true);
    const st = (await call(devCookie, 'GET', `/factories/${factoryId}/settings`)).json;
    expect(st.limits.maxConcurrentRuns).toBe(6);
    expect(st.budget.maxCostPerWorkItemUsd).toBe(40);
  });
  it('MCP setup snippets for the three local agents', async () => {
    const m = (await call(devCookie, 'GET', '/mcp-setup')).json;
    expect(Object.keys(m.snippets)).toEqual(['claude-code', 'codex', 'copilot', 'cursor']);
    expect(m.snippets['claude-code']).toContain('claude mcp add --transport http zerovity http://localhost:8787/mcp');
  });
  it('webhook admin: create, rotate, secret shown once', async () => {
    const c = (await call(adminCookie, 'POST', '/webhooks', { name: 'ci-alerts', factoryId })).json;
    expect(c.secret).toMatch(/^zfw_/);
    expect(JSON.stringify((await call(adminCookie, 'GET', '/webhooks')).json)).not.toContain(c.secret);
    const rot = (await call(adminCookie, 'POST', `/webhooks/${c.id}/rotate`)).json;
    expect(rot.secret).not.toBe(c.secret);
  });
  it('the floor view: lanes, counters, agents per lane, items with status', async () => {
    const wi = (await call(devCookie, 'POST', '/work-items', { factoryId, title: 'Floor probe', body: '[fake:ask]' })).json;
    await waitFor(async () => (await call(devCookie, 'GET', `/work-items/${wi.id}`)).json.workItem.state === 'NEEDS_INPUT');
    const fl = (await call(devCookie, 'GET', `/factories/${factoryId}/floor`)).json;
    expect(fl.lanes.map((l: { lane: string }) => l.lane)).toEqual(['INTENT', 'SPEC', 'GATE', 'BUILD', 'VERIFY', 'SHIP']);
    expect(fl.lanes.find((l: { lane: string }) => l.lane === 'BUILD')).toMatchObject({ agent: 'zerovity-executor', harness: 'fake' }); // forceHarness is on in this suite
    const it = fl.items.find((x: { id: string }) => x.id === wi.id);
    expect(it).toMatchObject({ lane: 'INTENT', status: 'ask' });
    expect(fl.counters.waiting).toBeGreaterThan(0);
    expect(fl.health.map((h: { label: string }) => h.label)).toEqual(['GitHub', 'Jira', 'Claude Code', 'Codex', 'Copilot', 'Cursor']);
    await call(devCookie, 'POST', `/work-items/${wi.id}/cancel`);
  });
  it('a 200-item floor responds quickly', async () => {
    await seedBulkItems(s, factoryId, 200);
    const t0 = Date.now();
    const fl = (await call(devCookie, 'GET', `/factories/${factoryId}/floor`)).json;
    expect(fl.items.length).toBeGreaterThanOrEqual(200);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('SSE', () => {
  it('streams run events and ends when the run is finished', async () => {
    const run = (await call(devCookie, 'GET', `/runs?factoryId=${factoryId}&status=done&limit=1`)).json[0];
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${addr}/api/v1/runs/${run.id}/stream`, { headers: { cookie: devCookie } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text(); // finished runs end the stream
    expect(text).toContain('event: event');
    expect(text).toContain('event: end');
    const ctrl = new AbortController();
    const evs = await fetch(`${addr}/api/v1/events?factoryId=${factoryId}`, { headers: { cookie: devCookie }, signal: ctrl.signal });
    const reader = evs.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('retry:');
    ctrl.abort();
  });
});

describe('Factory MCP server (spec 11.4)', () => {
  let pat = '';
  const rpc = async (method: string, params: unknown, id = 1) => {
    const r = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id, method, params } as never });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
  };
  const tool = async (name: string, args: Record<string, unknown>) => { const r = await rpc('tools/call', { name, arguments: args }); return { isError: r.body.result?.isError, data: (() => { try { return JSON.parse(r.body.result.content[0].text); } catch { return r.body.result?.content?.[0]?.text; } })() }; };
  beforeAll(async () => { pat = (await call(devCookie, 'POST', '/tokens', { name: 'mcp' })).json.token; });

  it('requires authentication', async () => {
    const r = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } as never, headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(401);
  });
  it('lists the eleven tools', async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const r = await rpc('tools/list', {});
    expect(r.body.result.tools.map((x: { name: string }) => x.name).sort()).toEqual(['add_context', 'complete_task', 'get_agent_context', 'get_conversation', 'get_schema', 'get_task', 'list_factories', 'list_tasks', 'message_foreman', 'search_tasks', 'send_task', 'validate_definition']);
  });
  it('send_task, get_task(start_working), message_foreman, add_context, get_agent_context, search', async () => {
    const f = (await tool('list_factories', {})).data;
    expect(f[0].name).toBe('payments-factory');
    const sent = (await tool('send_task', { factoryId, title: 'Local agent task', description: 'From my laptop. [fake:ask]', startPhase: 'INTENT' })).data;
    expect(sent.shortId).toMatch(/^ZF-/);
    await waitFor(async () => (await call(devCookie, 'GET', `/work-items/${sent.id}`)).json.workItem.state === 'NEEDS_INPUT');
    const g = (await tool('get_task', { taskId: sent.shortId, start_working: true })).data;
    expect(g.worktreeSetup.join(' ')).toContain(sent.branch ?? g.branch);
    expect(g.context.markdown).toContain('Context for');
    expect(g.questions.length).toBe(1);
    await tool('add_context', { taskId: sent.id, title: 'Laptop note', content: 'Prefer the feature-flag pattern.' });
    expect((await tool('get_agent_context', { taskId: sent.id, agent: 'zerovity-executor', phase: 'BUILD' })).data.markdown).toContain('feature-flag');
    expect((await tool('message_foreman', { taskId: sent.id, message: 'Yes' })).data.routedToQuestion).toBeTruthy(); // answers the waiting question
    await waitFor(async () => (await call(devCookie, 'GET', `/work-items/${sent.id}`)).json.workItem.state === 'AWAITING_SPEC_APPROVAL');
    expect((await tool('get_conversation', { taskId: sent.id })).data.length).toBeGreaterThan(2);
    expect((await tool('search_tasks', { query: 'Local agent' })).data[0].id).toBe(sent.id);
    expect((await tool('list_tasks', { factoryId, state: 'AWAITING_SPEC_APPROVAL' })).data.some((x: { id: string }) => x.id === sent.id)).toBe(true);
    const back = (await tool('send_task', { taskId: sent.id, branch: 'my-local-branch', note: 'Pushed my work.' })).data;
    expect(back.handedBack).toBe(true);
    expect((await tool('complete_task', { taskId: sent.id })).data.completed).toBe(false); // not awaiting handoff yet
    await call(devCookie, 'POST', `/work-items/${sent.id}/cancel`);
  });
  it('validate_definition and get_schema help a local agent edit a definition', async () => {
    const v = (await tool('validate_definition', { factoryId, files: { 'policies/gates.yaml': 'gates:\n  riskOverrides:\n    - if: triage.risk ==\n      add: [buildApproval]\n' } })).data;
    expect(v.ok).toBe(false);
    expect(v.issues.find((i: { code: string }) => i.code === 'policy_syntax')).toBeTruthy();
    expect((await tool('get_schema', { doc: 'agent' })).data.$id).toContain('agent');
  });
  it('permissions follow the caller: a viewer token cannot create tasks', async () => {
    const vt = (await call(viewerCookie, 'POST', '/tokens', { name: 'v' })).json.token;
    const r = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${vt}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'send_task', arguments: { factoryId, title: 'nope nope' } } } as never });
    expect(JSON.parse(r.body).result.isError).toBe(true);
  });
});

describe('inbound webhooks (GitHub and Jira signatures, tokens)', () => {
  it('GitHub: rejects unsigned requests; a signed label event creates a work item; a repeat does not duplicate', async () => {
    const created = await ctx.conns.create((await ctx.s.db.select().from(t.orgs))[0].id, { typeId: 'github-token', displayName: 'gh', values: { token: 'ghp_x', webhook_secret: 'whsec' }, by: 'admin' });
    expect(created.id).toBeTruthy();
    const payload = JSON.stringify({ action: 'labeled', label: { name: 'zerovity' }, issue: { number: 77, title: 'Rate limit quotes', body: 'Too many calls', html_url: 'https://github.com/acme/payments-service/issues/77', labels: [{ name: 'zerovity' }], user: { login: 'bob' } }, repository: { full_name: 'acme/payments-service' } });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'whsec').update(payload).digest('hex');
    const send = (p: string, sg?: string) => app.inject({ method: 'POST', url: '/api/v1/webhooks/github', payload: p, headers: { 'content-type': 'application/json', 'x-github-event': 'issues', ...(sg ? { 'x-hub-signature-256': sg } : {}) } });
    expect((await send(payload)).statusCode).toBe(401);
    expect((await send(payload, 'sha256=' + '0'.repeat(64))).statusCode).toBe(401);
    const ok = await send(payload, sig);
    expect(ok.statusCode).toBe(202);
    const items = (await call(devCookie, 'GET', `/work-items?factoryId=${factoryId}&q=Rate%20limit%20quotes`)).json.filter((x: { sourceType: string }) => x.sourceType === 'github');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceRef: 'acme/payments-service#77' });
    await send(payload, sig);
    expect((await call(devCookie, 'GET', `/work-items?factoryId=${factoryId}&q=Rate%20limit%20quotes`)).json.filter((x: { sourceType: string }) => x.sourceType === 'github')).toHaveLength(1);
    const ctxItems = (await call(devCookie, 'GET', `/context?workItemId=${items[0].id}&layer=workItem`)).json;
    expect(ctxItems.some((c: { kind: string }) => c.kind === 'ticket')).toBe(true);
    // a comment from a person routes to the item; a PR close completes the handoff flow
    const comment = JSON.stringify({ action: 'created', issue: { number: 77, title: 't', body: '', html_url: 'u', labels: [], user: { login: 'bob' } }, comment: { id: 5, body: 'Also cover the /v2 route', user: { login: 'bob', type: 'User' } }, repository: { full_name: 'acme/payments-service' } });
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/webhooks/github', payload: comment, headers: { 'content-type': 'application/json', 'x-github-event': 'issue_comment', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'whsec').update(comment).digest('hex') } });
    expect(r2.statusCode).toBe(202);
    const msgs = await s.db.select().from(t.messages).where(eq(t.messages.workItemId, items[0].id));
    expect(msgs.some((m) => m.body.includes('/v2 route') && m.channel === 'github')).toBe(true);
    await call(devCookie, 'POST', `/work-items/${items[0].id}/cancel`);
  });
  it('Jira: token-in-URL authentication; labelled issue in a mapped project creates a work item', async () => {
    const org = (await ctx.s.db.select().from(t.orgs))[0];
    const jc = await ctx.conns.create(org.id, { typeId: 'jira-dc', displayName: 'acme-jira', values: { baseUrl: 'https://jira.example.test', pat: 'pat-123456', webhookToken: 'jira-tok-1' }, by: 'admin' });
    await s.db.update(t.connections).set({ config: { ...(await ctx.conns.get(jc.id)).config, webhookToken: 'jira-tok-1' } }).where(eq(t.connections.id, jc.id));
    const payload = { webhookEvent: 'jira:issue_created', issue: { key: 'PAY-501', fields: { summary: 'Settlement report timezone', description: 'Wrong zone', labels: ['zerovity'], project: { key: 'PAY' }, reporter: { displayName: 'Rae' } } } };
    expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks/jira/wrong', payload, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/webhooks/jira/jira-tok-1', payload, headers: { 'content-type': 'application/json' } });
    expect(ok.statusCode).toBe(202);
    const items = (await call(devCookie, 'GET', `/work-items?factoryId=${factoryId}&q=Settlement%20report%20timezone`)).json.filter((x: { sourceType: string }) => x.sourceType === 'jira');
    expect(items).toHaveLength(1);
    expect(items[0].sourceRef).toBe('PAY-501');
    await call(devCookie, 'POST', `/work-items/${items[0].id}/cancel`);
  });
  it('inbound automation webhook: secret header authenticates; wrong secret is rejected', async () => {
    const files = { ...(await s.defs.getVersion(factoryId))!.files, 'automations/ci-alerts/automation.md': '---\nenabled: true\nagent: foreman\ntriggers:\n  - provider: webhook\n    name: ci-alerts\n---\nTriage the alert.\n' };
    expect((await call(adminCookie, 'PUT', `/factories/${factoryId}/definition`, { files, message: 'add webhook automation' })).json.applied).toBe(true);
    const wh = (await call(adminCookie, 'POST', '/webhooks', { name: 'ci-alerts', factoryId })).json;
    const path = new URL(wh.url).pathname;
    const bad = await app.inject({ method: 'POST', url: path, payload: { title: 'Alert' }, headers: { 'x-zerovity-secret': 'nope', 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: path, payload: { title: 'Build is red on main', body: 'See CI' }, headers: { 'x-zerovity-secret': wh.secret, 'content-type': 'application/json' } });
    expect(good.statusCode).toBe(202);
    expect(good.json().workItemId).toBeTruthy();
    await call(devCookie, 'POST', `/work-items/${good.json().workItemId}/cancel`);
  });
});


describe('sessions can be ended, and member management stays inside the organisation', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('sign out everywhere ends earlier sessions at once, and a fresh sign-in works', async () => {
    const old = await login('sess1@acme.test');
    expect((await call(old, 'GET', '/me')).status).toBe(200);
    expect((await call(old, 'POST', '/auth/logout-all')).status).toBe(200);
    expect((await call(old, 'GET', '/me')).status).toBe(401); // the cookie itself is still validly signed
    await sleep(5);
    const fresh = await login('sess1@acme.test');
    expect((await call(fresh, 'GET', '/me')).status).toBe(200);
  });
  it('an admin can end another person\'s sessions; others cannot', async () => {
    const victim = await login('sess2@acme.test');
    const me = (await call(victim, 'GET', '/me')).json;
    expect((await call(devCookie, 'POST', `/members/${me.id}/revoke-sessions`)).status).toBe(403);
    expect((await call(adminCookie, 'POST', `/members/${me.id}/revoke-sessions`)).status).toBe(200);
    expect((await call(victim, 'GET', '/me')).status).toBe(401);
  });
  it('changing a role changes only the matching membership, not every one the person has', async () => {
    const email = 'scoped@acme.test';
    expect((await call(adminCookie, 'POST', '/members', { email, name: 'Scoped', role: 'member' })).status).toBe(200);
    expect((await call(adminCookie, 'POST', '/members', { email, name: 'Scoped', role: 'approver', factoryId })).status).toBe(200);
    expect((await call(adminCookie, 'POST', '/members', { email, name: 'Scoped', role: 'viewer' })).status).toBe(200); // org-wide downgrade
    const m = (await call(adminCookie, 'GET', '/members')).json.find((x: { email: string }) => x.email === email);
    expect(m.memberships.find((x: { factoryId: string | null }) => x.factoryId === null).role).toBe('viewer');
    expect(m.memberships.find((x: { factoryId: string | null }) => x.factoryId === factoryId).role).toBe('approver');
  });
  it('removing a member only works for people in the caller\'s organisation', async () => {
    const otherOrg = ulid(), otherUser = ulid();
    await s.db.insert(t.orgs).values({ id: otherOrg, name: 'Other', slug: 'other-org' });
    await s.db.insert(t.users).values({ id: otherUser, orgId: otherOrg, email: 'x@other.test', name: 'X' });
    await s.db.insert(t.memberships).values({ id: ulid(), userId: otherUser, orgId: otherOrg, factoryId: null, role: 'member' });
    expect((await call(adminCookie, 'DELETE', `/members/${otherUser}`)).status).toBe(404);
    const stillThere = await s.db.select().from(t.memberships).where(eq(t.memberships.userId, otherUser));
    expect(stillThere).toHaveLength(1); // nothing of theirs was touched
  });
  it('two deliveries of the same issue at once create exactly one work item', async () => {
    const src = { type: 'github', ref: `acme/payments-service#${Date.now()}` };
    const made = await Promise.all([1, 2, 3, 4].map(() => s.orch.createWorkItem({ factoryId, title: 'Same issue', source: src })));
    expect(new Set(made.map((w) => w.id)).size).toBe(1);
    const rows = await s.db.select().from(t.workItems).where(eq(t.workItems.sourceRef, src.ref));
    expect(rows).toHaveLength(1);
  });
});

describe('several workers: starting one must not fail the others\' runs', () => {
  const mkRun = async (lockedUntil: Date | null) => {
    const wiId = ulid(), runId = ulid();
    await s.db.insert(t.workItems).values({ id: wiId, factoryId, shortId: `RC-${wiId.slice(-8)}`, seq: 900000, title: 'recon', state: 'BUILD' });
    await s.db.insert(t.runs).values({ id: runId, workItemId: wiId, factoryId, agentName: 'zerovity-executor', phase: 'BUILD', harness: 'fake', status: 'running', startedAt: new Date() });
    const jobId = ulid();
    if (lockedUntil) await s.db.insert(t.jobs).values({ id: jobId, queue: 'run', payload: { runId }, state: 'active', lockedBy: 'other-worker', lockedUntil });
    const status = async () => (await s.db.select().from(t.runs).where(eq(t.runs.id, runId)))[0];
    return { runId, jobId, status };
  };
  it('a run held by a live worker is left alone, however long it has been running', async () => {
    const r = await mkRun(new Date(Date.now() + 60_000));
    await s.orch.reconcile(0);
    expect((await r.status()).status).toBe('running');
  });
  it('a run whose worker stopped heartbeating is failed, so the item can be retried', async () => {
    const r = await mkRun(new Date(Date.now() - 1_000));
    await s.orch.reconcile(0);
    expect(await r.status()).toMatchObject({ status: 'failed', exitReason: 'worker_lost' });
  });
  it('a run with no job at all is an orphan and is failed', async () => {
    const r = await mkRun(null);
    await s.orch.reconcile(0);
    expect((await r.status()).status).toBe('failed');
  });
  it('the single embedded worker may ignore locks, because nothing else can be running', async () => {
    const r = await mkRun(new Date(Date.now() + 60_000));
    await s.orch.reconcile(0, { ignoreLocks: true });
    expect((await r.status()).status).toBe('failed');
  });
});
// Regression: the connection Test button (a bodiless POST) answered "415 Unsupported Media Type" when the client sent a non-JSON content type.
describe('bodiless action requests', () => {
  it('accept any content type and an empty body', async () => {
    for (const headers of [{}, { 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': 'text/plain' }]) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers, payload: '' });
      expect(r.statusCode, JSON.stringify(headers)).toBe(200);
    }
  });
});
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { tables as t, verifyAudit, readChain } from '@zerovity/db';
import { toCsv, toJsonl } from '@zerovity/audit';
import { notFound, invalid, ulid, ResultSchema, type RunResult, type Role, ROLES } from '@zerovity/core';
import { floorView, listWorkItems, workItemDetail, runDetail, listRuns, runEventsAfter, loadExample, createFactory, ensureUser, type Services } from '@zerovity/orchestrator';
import { hasErrors, loadDir } from '@zerovity/definition';
import { user, factoryFor, itemFor, runFor, type AppCtx } from '../context';
import { WorkItemS, RunS, InboxS, QuestionS, GateS, FactoryS, Ok, Any, IdP, D } from '../schemas';

export async function coreRoutes(app0: FastifyInstance, ctx: AppCtx) {
  const app = app0.withTypeProvider<ZodTypeProvider>();
  const { s, auth } = ctx;
  const db = s.db;

  /* ---------------- me, tokens, members ---------------- */
  app.get('/me', { schema: { response: { 200: z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.string(), orgId: z.string(), groups: z.array(z.string()), factories: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })) }) } } }, async (req) => {
    const u = user(req);
    const facs = await db.select().from(t.factories).where(eq(t.factories.orgId, u.orgId));
    return { id: u.id, email: u.email, name: u.name, role: u.role, orgId: u.orgId, groups: u.groups, factories: facs.map((f) => ({ id: f.id, name: f.name, role: auth.roleFor(u, f.id) })) };
  });

  app.get('/tokens', { schema: { response: { 200: z.array(z.object({ id: z.string(), name: z.string(), prefix: z.string(), lastUsedAt: D.nullable(), expiresAt: D.nullable(), createdAt: D })) } } }, async (req) => {
    const rows = await db.select().from(t.personalAccessTokens).where(eq(t.personalAccessTokens.userId, user(req).id)).orderBy(desc(t.personalAccessTokens.createdAt));
    return rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, lastUsedAt: r.lastUsedAt, expiresAt: r.expiresAt, createdAt: r.createdAt }));
  });
  app.post('/tokens', { schema: { body: z.object({ name: z.string().min(1).max(80), days: z.number().int().positive().max(365).optional() }), response: { 200: z.object({ id: z.string(), token: z.string() }) } } }, async (req) => auth.createPat(user(req).id, req.body.name, req.body.days));
  app.delete('/tokens/:id', { schema: { params: IdP, response: { 200: Ok } } }, async (req) => {
    await db.delete(t.personalAccessTokens).where(and(eq(t.personalAccessTokens.id, req.params.id), eq(t.personalAccessTokens.userId, user(req).id)));
    return { ok: true };
  });

  app.get('/members', { schema: { response: { 200: z.array(Any) } } }, async (req) => {
    const u = user(req);
    const us = await db.select().from(t.users).where(eq(t.users.orgId, u.orgId));
    const ms = await db.select().from(t.memberships).where(eq(t.memberships.orgId, u.orgId));
    return us.map((x) => ({ id: x.id, email: x.email, name: x.name, groups: x.groups, memberships: ms.filter((m) => m.userId === x.id).map((m) => ({ id: m.id, factoryId: m.factoryId, role: m.role })) }));
  });
  app.post('/members', { schema: { body: z.object({ email: z.string().email(), name: z.string().min(1), role: z.enum(ROLES), factoryId: z.string().nullable().optional(), groups: z.array(z.string()).optional() }), response: { 200: Any } } }, async (req) => {
    const u = user(req);
    auth.need(u, 'org_admin');
    const created = await ensureUser(db, u.orgId, { email: req.body.email, name: req.body.name, role: req.body.role as Role, groups: req.body.groups, factoryId: req.body.factoryId ?? null });
    const has = await db.select().from(t.memberships).where(and(eq(t.memberships.userId, created.id), eq(t.memberships.orgId, u.orgId)));
    if (!has.some((m) => (m.factoryId ?? null) === (req.body.factoryId ?? null))) await db.insert(t.memberships).values({ id: ulid(), userId: created.id, orgId: u.orgId, factoryId: req.body.factoryId ?? null, role: req.body.role });
    else await db.update(t.memberships).set({ role: req.body.role }).where(and(eq(t.memberships.userId, created.id), eq(t.memberships.orgId, u.orgId)));
    if (req.body.groups) await db.update(t.users).set({ groups: req.body.groups }).where(eq(t.users.id, created.id));
    await s.orch.audit(u.orgId, u.id, 'member.upserted', req.body.email, { role: req.body.role, factoryId: req.body.factoryId ?? null }).catch(() => undefined);
    return { id: created.id };
  });
  app.delete('/members/:id', { schema: { params: IdP, response: { 200: Ok } } }, async (req) => {
    const u = user(req);
    auth.need(u, 'org_admin');
    if (req.params.id === u.id) throw invalid('You cannot remove yourself');
    await db.delete(t.memberships).where(eq(t.memberships.userId, req.params.id));
    await db.delete(t.personalAccessTokens).where(eq(t.personalAccessTokens.userId, req.params.id));
    await db.delete(t.users).where(and(eq(t.users.id, req.params.id), eq(t.users.orgId, u.orgId)));
    return { ok: true };
  });

  /* ---------------- factories ---------------- */
  app.get('/factories', { schema: { response: { 200: z.array(FactoryS) } } }, async (req) => db.select().from(t.factories).where(eq(t.factories.orgId, user(req).orgId)).orderBy(asc(t.factories.name)));

  app.post('/factories', {
    schema: { body: z.object({ example: z.enum(['01-single-repo', '02-issue-to-pr']).optional(), files: z.record(z.string(), z.string()).optional(), name: z.string().optional(), gitRepo: z.object({ owner: z.string(), name: z.string(), branch: z.string().default('main'), path: z.string().default('') }).optional() }), response: { 200: z.object({ id: z.string(), ok: z.boolean(), issues: z.array(Any) }) } },
  }, async (req) => {
    const u = user(req);
    auth.need(u, 'org_admin');
    const files = req.body.files ?? loadExample(s.repoRoot, req.body.example ?? '01-single-repo');
    if (req.body.name && files['zerovity.factory.yaml']) files['zerovity.factory.yaml'] = files['zerovity.factory.yaml'].replace(/^name:.*$/m, `name: ${req.body.name}`);
    const r = await createFactory(s, { orgId: u.orgId, files, by: u.id, name: req.body.name });
    if (req.body.gitRepo) await db.update(t.factories).set({ definitionSource: 'git', definitionRepo: { forge: 'github', ...req.body.gitRepo } }).where(eq(t.factories.id, r.factoryId));
    return { id: r.factoryId, ok: r.apply.ok, issues: r.apply.issues };
  });

  app.get('/factories/:id', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const a = await s.defs.getActive(f.id);
    const repos = await db.select().from(t.repositories).where(eq(t.repositories.factoryId, f.id));
    const n = await db.$count(t.workItems, eq(t.workItems.factoryId, f.id));
    return { ...f, repositories: repos, alias: a?.definition.factory.alias ?? f.alias, description: a?.definition.factory.description ?? '', agents: [...(a?.agents.values() ?? [])].map((x) => ({ name: x.name, phase: x.fm.phase })), workItemCount: n, commit: f.definitionCommit };
  });
  app.patch('/factories/:id', { schema: { params: IdP, body: z.object({ paused: z.boolean().optional(), settings: z.record(z.string(), z.unknown()).optional() }), response: { 200: FactoryS } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const [row] = await db.update(t.factories).set({ ...(req.body.paused !== undefined ? { paused: req.body.paused } : {}), ...(req.body.settings ? { settings: { ...f.settings, ...req.body.settings } } : {}), updatedAt: new Date() }).where(eq(t.factories.id, f.id)).returning();
    if (req.body.paused !== undefined) await s.orch.audit(f.id, u.id, req.body.paused ? 'factory.paused' : 'factory.resumed', f.name, {});
    s.hub.emit({ type: 'changed', factoryId: f.id });
    return row;
  });

  app.get('/factories/:id/floor', { schema: { params: IdP, querystring: z.object({ days: z.coerce.number().int().min(1).max(90).optional() }), response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const v = await floorView(db, s.defs, f.id, { sinceDays: req.query.days });
    const conns = await ctx.conns.list(f.orgId);
    return { ...v, factory: { id: f.id, name: f.name, paused: f.paused }, health: healthPills(conns, await s.defs.getActive(f.id)) };
  });

  /* ---------------- work items ---------------- */
  app.get('/work-items', { schema: { querystring: z.object({ factoryId: z.string(), state: z.string().optional(), q: z.string().optional(), source: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }), response: { 200: z.array(WorkItemS) } } }, async (req) => {
    await factoryFor(ctx, req, req.query.factoryId);
    return listWorkItems(db, { factoryId: req.query.factoryId, state: req.query.state?.split(','), q: req.query.q, source: req.query.source, limit: req.query.limit, offset: req.query.offset });
  });

  app.post('/work-items', {
    schema: { body: z.object({ factoryId: z.string(), title: z.string().min(3).max(300), body: z.string().max(100_000).default(''), repoId: z.string().optional(), startPhase: z.enum(['auto', 'INTENT', 'SPEC', 'BUILD']).default('auto'), budgetUsd: z.number().positive().optional(), context: z.array(z.object({ title: z.string(), body: z.string().default(''), kind: z.enum(['note', 'url', 'glossary', 'adr', 'ticket']).default('note'), url: z.string().url().optional() })).default([]), notify: z.enum(['web', 'email']).optional() }), response: { 200: WorkItemS } },
  }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.body.factoryId, 'member');
    const notes = req.body.context.filter((c) => !c.url);
    const wi = await s.orch.createWorkItem({ factoryId: f.id, title: req.body.title, body: req.body.body, repoId: req.body.repoId, startPhase: req.body.startPhase, budgetUsd: req.body.budgetUsd, requesterId: u.id, requesterName: u.name, actor: u.id, source: { type: 'web' }, context: notes.map((c) => ({ layer: 'workItem' as const, title: c.title, body: c.body, kind: c.kind, priority: 'always' as const })) });
    for (const c of req.body.context.filter((x) => x.url)) await s.contexts.attachUrl(f.orgId, { layer: 'workItem', scopeId: wi.id, url: c.url!, title: c.title, factoryId: f.id }, u.id).catch(() => undefined);
    return wi;
  });

  app.get('/work-items/:id', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    await itemFor(ctx, req, req.params.id);
    return workItemDetail(db, s.defs, req.params.id);
  });
  app.post('/work-items/:id/cancel', { schema: { params: IdP, response: { 200: Ok } } }, async (req) => { const { u } = await itemFor(ctx, req, req.params.id, 'member'); await s.orch.cancelWorkItem(req.params.id, u.id); return { ok: true }; });
  app.post('/work-items/:id/retry', { schema: { params: IdP, response: { 200: Ok } } }, async (req) => { const { u } = await itemFor(ctx, req, req.params.id, 'member'); await s.orch.retryWorkItem(req.params.id, u.id); return { ok: true }; });
  app.post('/work-items/:id/handoff', { schema: { params: IdP, response: { 200: Ok } } }, async (req) => { const { u } = await itemFor(ctx, req, req.params.id, 'member'); await s.orch.markHandedOff(req.params.id, u.id); return { ok: true }; });
  app.post('/work-items/:id/messages', { schema: { params: IdP, body: z.object({ body: z.string().min(1).max(20_000) }), response: { 200: Any } } }, async (req) => {
    const { u } = await itemFor(ctx, req, req.params.id, 'member');
    return s.orch.ingestMessage(req.params.id, { body: req.body.body, authorName: u.name, authorId: u.id, channel: 'web' });
  });

  app.get('/work-items/:id/spec', { schema: { params: IdP, response: { 200: z.object({ text: z.string().nullable(), previous: z.string().nullable(), runId: z.string().nullable(), pendingGate: Any, approvedHash: z.string().nullable() }) } } }, async (req) => {
    await itemFor(ctx, req, req.params.id);
    const run = await s.orch.latestRun(req.params.id, 'SPEC');
    const gate = await s.orch.pendingGate(req.params.id);
    const [approved] = await db.select().from(t.gates).where(and(eq(t.gates.workItemId, req.params.id), eq(t.gates.type, 'specApproval'), eq(t.gates.status, 'approved')));
    const specRuns = await db.select().from(t.runs).where(and(eq(t.runs.workItemId, req.params.id), eq(t.runs.phase, 'SPEC'), eq(t.runs.status, 'done'))).orderBy(desc(t.runs.createdAt)).limit(2);
    const prev = specRuns[1] ? (await s.artifacts.get(`runs/${specRuns[1].id}/out/spec.md`))?.toString('utf8') ?? null : null;
    return { text: (await s.orch.specText(req.params.id)) ?? null, previous: prev, runId: run?.id ?? null, pendingGate: gate?.type === 'specApproval' ? gate : null, approvedHash: approved?.subjectHash ?? null };
  });

  app.get('/work-items/:id/changes', { schema: { params: IdP, response: { 200: z.object({ diff: z.string(), runId: z.string().nullable(), files: z.array(z.string()) }) } } }, async (req) => {
    await itemFor(ctx, req, req.params.id);
    const runs = await db.select().from(t.runs).where(and(eq(t.runs.workItemId, req.params.id), inArray(t.runs.status, ['done']))).orderBy(desc(t.runs.createdAt));
    for (const r of runs) { const d = await s.artifacts.get(`runs/${r.id}/diff.patch`); if (d) return { diff: d.toString('utf8'), runId: r.id, files: [...d.toString('utf8').matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]) }; }
    return { diff: '', runId: null, files: [] };
  });

  app.get('/work-items/:id/evidence', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    await itemFor(ctx, req, req.params.id);
    const runs = await db.select().from(t.runs).where(eq(t.runs.workItemId, req.params.id)).orderBy(asc(t.runs.createdAt));
    const evidence: unknown[] = [], findings: unknown[] = [], files: unknown[] = [];
    for (const r of runs) {
      const res = r.resultJson as RunResult | null;
      for (const e of res?.evidence ?? []) evidence.push({ ...e, runId: r.id, phase: r.phase, agent: r.agentName });
      for (const f of res?.findings ?? []) findings.push({ ...f, runId: r.id, phase: r.phase, agent: r.agentName });
      for (const key of await s.artifacts.list(`runs/${r.id}/out`)) files.push({ runId: r.id, phase: r.phase, name: key.replace(`runs/${r.id}/out/`, ''), key });
    }
    return { evidence, findings, files, recommendation: [...runs].reverse().map((r) => (r.resultJson as RunResult | null)?.recommendation).find(Boolean) ?? null };
  });

  app.get('/artifacts', { schema: { querystring: z.object({ runId: z.string(), name: z.string() }) } }, async (req, reply) => {
    await runFor(ctx, req, req.query.runId);
    if (req.query.name.includes('..')) throw invalid('bad name');
    const buf = await s.artifacts.get(`runs/${req.query.runId}/out/${req.query.name}`);
    if (!buf) throw notFound('Artifact', req.query.name);
    const ext = req.query.name.split('.').pop()?.toLowerCase() ?? '';
    const type = { md: 'text/markdown', json: 'application/json', log: 'text/plain', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', patch: 'text/x-diff' }[ext] ?? 'application/octet-stream';
    return reply.header('content-type', `${type}; charset=utf-8`).header('x-content-type-options', 'nosniff').header('content-disposition', `inline; filename="${req.query.name.split('/').pop()}"`).send(buf);
  });

  app.get('/work-items/:id/audit', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const { w } = await itemFor(ctx, req, req.params.id);
    const chain = await readChain(db, w.factoryId);
    const runIds = new Set((await db.select({ id: t.runs.id }).from(t.runs).where(eq(t.runs.workItemId, w.id))).map((r) => r.id));
    const entries = chain.filter((e) => e.subject === w.shortId || runIds.has((e.payload as { runId?: string } | null)?.runId ?? ''));
    return { entries, verified: await verifyAudit(db, w.factoryId) };
  });

  /* ---------------- runs ---------------- */
  app.get('/runs', { schema: { querystring: z.object({ factoryId: z.string(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), response: { 200: z.array(RunS) } } }, async (req) => {
    await factoryFor(ctx, req, req.query.factoryId);
    return listRuns(db, { factoryId: req.query.factoryId, status: req.query.status?.split(','), limit: req.query.limit });
  });
  app.get('/runs/:id', { schema: { params: IdP, response: { 200: Any } } }, async (req) => { await runFor(ctx, req, req.params.id); return runDetail(db, req.params.id); });
  app.get('/runs/:id/events', { schema: { params: IdP, querystring: z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(2000).default(500) }), response: { 200: Any } } }, async (req) => {
    await runFor(ctx, req, req.params.id);
    return runEventsAfter(db, req.params.id, req.query.after, req.query.limit);
  });
  app.get('/runs/:id/context', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    await runFor(ctx, req, req.params.id);
    const buf = await s.artifacts.get(`runs/${req.params.id}/context.json`);
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  });
  app.get('/runs/:id/transcript', { schema: { params: IdP } }, async (req, reply) => {
    const { r } = await runFor(ctx, req, req.params.id);
    const ev = await runEventsAfter(db, r.id, 0, 100_000);
    return reply.header('content-type', 'application/x-ndjson').header('content-disposition', `attachment; filename="${r.id}.jsonl"`).send(ev.map((e) => JSON.stringify({ seq: e.seq, ts: e.ts, ...e.payload })).join('\n') + '\n');
  });
  app.post('/runs/:id/stop', { schema: { params: IdP, response: { 200: Ok } } }, async (req) => { const { u } = await runFor(ctx, req, req.params.id, 'member'); await s.orch.stopRun(req.params.id, u.id); return { ok: true }; });
  app.post('/runs/:id/followup', { schema: { params: IdP, body: z.object({ message: z.string().min(1).max(10_000) }), response: { 200: z.object({ mode: z.enum(['live', 'queued']), runId: z.string() }) } } }, async (req) => { const { u } = await runFor(ctx, req, req.params.id, 'member'); return s.orch.followup(req.params.id, req.body.message, u.id); });

  /* ---------------- inbox, questions, gates ---------------- */
  app.get('/inbox', { schema: { querystring: z.object({ factoryId: z.string().optional(), kind: z.string().optional(), status: z.enum(['open', 'resolved', 'all']).default('open'), unread: z.coerce.boolean().optional(), q: z.string().optional(), mine: z.coerce.boolean().optional() }), response: { 200: z.array(InboxS) } } }, async (req) => {
    const u = user(req);
    return s.orch.inbox.list({ orgId: u.orgId, factoryId: req.query.factoryId, kind: req.query.kind, status: req.query.status, unread: req.query.unread, q: req.query.q, userId: req.query.mine ? u.id : undefined });
  });
  app.get('/inbox/counts', { schema: { response: { 200: z.object({ open: z.number(), unread: z.number(), byKind: z.record(z.string(), z.number()) }) } } }, async (req) => s.orch.inbox.counts(user(req).orgId));
  app.get('/inbox/:id', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const u = user(req);
    const item = await s.orch.inbox.get(req.params.id);
    if (item.orgId !== u.orgId) throw notFound('Inbox item', req.params.id);
    const questions = item.workItemId ? await db.select().from(t.questions).where(eq(t.questions.workItemId, item.workItemId)) : [];
    const gate = item.workItemId ? (await db.select().from(t.gates).where(eq(t.gates.workItemId, item.workItemId)).orderBy(desc(t.gates.requestedAt)))[0] : undefined;
    const wi = item.workItemId ? (await db.select().from(t.workItems).where(eq(t.workItems.id, item.workItemId)))[0] : undefined;
    return { item, workItem: wi, question: questions.find((q) => `q:${q.id}` === item.refKey) ?? null, gate: gate ?? null, spec: item.kind === 'spec_approval' && item.workItemId ? ((await s.orch.specText(item.workItemId)) ?? null) : null };
  });
  app.post('/inbox/:id/read', { schema: { params: IdP, body: z.object({ read: z.boolean().default(true) }).default({ read: true }), response: { 200: Ok } } }, async (req) => { await s.orch.inbox.markRead(req.params.id, req.body.read); return { ok: true }; });
  app.post('/inbox/:id/resolve', { schema: { params: IdP, response: { 200: InboxS } } }, async (req) => s.orch.inbox.resolve(req.params.id, user(req).id));
  app.post('/inbox/:id/reopen', { schema: { params: IdP, response: { 200: InboxS } } }, async (req) => s.orch.inbox.reopen(req.params.id));

  app.post('/questions/:id/answer', { schema: { params: IdP, body: z.object({ answer: z.string().max(20_000).default(''), url: z.string().url().optional(), contextItemId: z.string().optional() }), response: { 200: QuestionS } } }, async (req) => {
    const u = user(req);
    const [q] = await db.select().from(t.questions).where(eq(t.questions.id, req.params.id));
    if (!q) throw notFound('Question', req.params.id);
    const { w, f } = await itemFor(ctx, req, q.workItemId, 'member');
    let contextItemId = req.body.contextItemId;
    if (req.body.url) contextItemId = (await s.contexts.attachUrl(f.orgId, { layer: 'workItem', scopeId: w.id, url: req.body.url, factoryId: f.id }, u.id)).id;
    return s.orch.answerQuestion(req.params.id, { answer: req.body.answer || (req.body.url ? `Link: ${req.body.url}` : ''), by: u.id, byName: u.name, contextItemId });
  });
  app.post('/questions/:id/answer-file', { schema: { params: IdP, response: { 200: QuestionS } } }, async (req) => {
    const u = user(req);
    const [q] = await db.select().from(t.questions).where(eq(t.questions.id, req.params.id));
    if (!q) throw notFound('Question', req.params.id);
    const { w, f } = await itemFor(ctx, req, q.workItemId, 'member');
    const file = await req.file();
    if (!file) throw invalid('A file is required');
    const data = await file.toBuffer();
    const item = await s.contexts.attachFile(f.orgId, { layer: 'workItem', scopeId: w.id, name: file.filename, data, factoryId: f.id }, u.id);
    return s.orch.answerQuestion(req.params.id, { answer: `Attachment: ${file.filename}`, by: u.id, byName: u.name, contextItemId: item.id });
  });

  app.post('/gates/:id/decision', { schema: { params: IdP, body: z.object({ decision: z.enum(['approve', 'changes']), reason: z.string().max(5000).optional(), comments: z.array(z.object({ file: z.string().optional(), line: z.number().int().optional(), text: z.string().min(1) })).default([]) }), response: { 200: GateS } } }, async (req) => {
    const u = user(req);
    const [g] = await db.select().from(t.gates).where(eq(t.gates.id, req.params.id));
    if (!g) throw notFound('Gate', req.params.id);
    const { f } = await itemFor(ctx, req, g.workItemId, 'approver');
    return s.orch.decideGate(g.id, { decision: req.body.decision, by: u.id, byName: u.name, groups: u.groups, role: auth.roleFor(u, f.id), reason: req.body.reason, comments: req.body.comments, reauthenticated: !!u.reauthAt && Date.now() - u.reauthAt < 5 * 60_000 });
  });

  /* ---------------- audit ---------------- */
  app.get('/factories/:id/audit', { schema: { params: IdP, querystring: z.object({ from: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(1000).default(200) }), response: { 200: Any } } }, async (req) => {
    await factoryFor(ctx, req, req.params.id);
    const entries = await readChain(db, req.params.id, { from: req.query.from, limit: req.query.limit });
    return { entries, verified: await verifyAudit(db, req.params.id) };
  });
  app.get('/factories/:id/audit/verify', { schema: { params: IdP, response: { 200: Any } } }, async (req) => { await factoryFor(ctx, req, req.params.id); return verifyAudit(db, req.params.id); });
  app.get('/factories/:id/audit/export', { schema: { params: IdP, querystring: z.object({ format: z.enum(['jsonl', 'csv']).default('jsonl') }) } }, async (req, reply) => {
    await factoryFor(ctx, req, req.params.id, 'approver');
    const entries = await readChain(db, req.params.id);
    return reply.header('content-type', req.query.format === 'csv' ? 'text/csv' : 'application/x-ndjson').header('content-disposition', `attachment; filename="audit-${req.params.id}.${req.query.format}"`).send(req.query.format === 'csv' ? toCsv(entries) : toJsonl(entries));
  });
}

/** Health pills for the top bar: which connections/harnesses are working. */
export function healthPills(conns: Array<{ type: string; provider: string; displayName: string; status: string; lastError: string | null }>, active?: { agents: Map<string, { fm: { harness?: { type?: string } } }> } | undefined) {
  const pill = (label: string, match: (c: { type: string; provider: string }) => boolean) => {
    const cs = conns.filter(match);
    const bad = cs.find((c) => c.status !== 'connected');
    return { label, state: !cs.length ? 'none' : bad ? 'warn' : 'ok', detail: bad?.lastError ?? (cs.length ? 'connected' : 'not connected') };
  };
  void active;
  return [pill('GitHub', (c) => c.provider === 'github' && c.type === 'forge'), pill('Jira', (c) => c.type === 'tracker'), pill('Claude Code', (c) => ['anthropic', 'bedrock', 'vertex'].includes(c.provider)), pill('Codex', (c) => c.provider === 'openai'), pill('Copilot', (c) => c.provider === 'copilot')];
}

export type { Services };
export { hasErrors, loadDir, ResultSchema };

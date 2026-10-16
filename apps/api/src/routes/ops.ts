import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq } from 'drizzle-orm';
import { stringify as yamlStringify, parse as parseYaml } from 'yaml';
import { tables as t, seedPrices } from '@zerovity/db';
import { dashboardView, usageRollup, agentStats } from '@zerovity/orchestrator';
import { notFound, invalid, ulid } from '@zerovity/core';
import { user, factoryFor, type AppCtx } from '../context';
import { IdP, Any, Ok } from '../schemas';
import type { Files } from '@zerovity/definition';

const range = z.object({ from: z.string().optional(), to: z.string().optional(), days: z.coerce.number().int().min(1).max(365).optional() });
const toRange = (q: z.infer<typeof range>) => { const to = q.to ? new Date(q.to) : new Date(); const from = q.from ? new Date(q.from) : new Date(to.getTime() - (q.days ?? 7) * 86_400_000); return { from, to }; };

export async function opsRoutes(app0: FastifyInstance, ctx: AppCtx) {
  const app = app0.withTypeProvider<ZodTypeProvider>();
  const { s, auth } = ctx;
  const db = s.db;

  /* ------------------------------------------------------------- dashboard, usage */
  app.get('/factories/:id/dashboard', { schema: { params: IdP, querystring: range, response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const { from, to } = toRange(req.query);
    return dashboardView(db, f.id, from, to);
  });
  app.get('/factories/:id/usage', { schema: { params: IdP, querystring: range.extend({ by: z.enum(['workItem', 'agent', 'harness', 'model', 'day']).default('harness') }), response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const { from, to } = toRange(req.query);
    return usageRollup(db, f.id, from, to, req.query.by);
  });
  app.get('/factories/:id/usage.csv', { schema: { params: IdP, querystring: range.extend({ by: z.enum(['workItem', 'agent', 'harness', 'model', 'day']).default('workItem') }) } }, async (req, reply) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const { from, to } = toRange(req.query);
    const rows = await usageRollup(db, f.id, from, to, req.query.by);
    const csv = ['key,runs,tokens_in,tokens_out,tokens_cached,cost_usd,premium_requests', ...rows.map((r) => [r.key, r.runs, r.tokensIn, r.tokensOut, r.tokensCached, r.costUsd.toFixed(4), r.premiumRequests].join(','))].join('\n') + '\n';
    return reply.header('content-type', 'text/csv').header('content-disposition', `attachment; filename="usage-${req.query.by}.csv"`).send(csv);
  });
  app.get('/factories/:id/agent-stats', { schema: { params: IdP, response: { 200: Any } } }, async (req) => { const { f } = await factoryFor(ctx, req, req.params.id); return agentStats(db, f.id); });

  /* ------------------------------------------------------------- scorers */
  const Scorer = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]*$/), description: z.string().default(''), rubric: z.string().min(1), labels: z.array(z.string()).min(2).default(['pass', 'fail']), passLabels: z.array(z.string()).default(['pass']), sampling: z.number().min(0).max(1).default(0.2), appliesTo: z.object({ phases: z.array(z.string()).default([]), agents: z.array(z.string()).default([]) }).default({ phases: [], agents: [] }), enabled: z.boolean().default(true) });
  app.get('/factories/:id/scorers', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const rows = await db.select().from(t.scorers).where(eq(t.scorers.factoryId, f.id));
    const rates = await s.scoring.passRates(f.id);
    return rows.map((r) => ({ ...r, stats: rates.find((x) => x.scorerId === r.id) ?? null }));
  });
  app.put('/factories/:id/scorers/:name', { schema: { params: z.object({ id: z.string(), name: z.string() }), body: Scorer.omit({ name: true }), response: { 200: Any } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    for (const l of req.body.passLabels) if (!req.body.labels.includes(l)) throw invalid(`passLabel "${l}" is not in labels`);
    const [ex] = await db.select().from(t.scorers).where(and(eq(t.scorers.factoryId, f.id), eq(t.scorers.name, req.params.name)));
    const v = { description: req.body.description, rubric: req.body.rubric, labels: req.body.labels, passLabels: req.body.passLabels, sampling: req.body.sampling, appliesTo: req.body.appliesTo, enabled: req.body.enabled, updatedAt: new Date() };
    if (ex) await db.update(t.scorers).set(v).where(eq(t.scorers.id, ex.id));
    else await db.insert(t.scorers).values({ id: ulid(), factoryId: f.id, name: req.params.name, ...v });
    await s.orch.audit(f.id, u.id, 'scorer.saved', req.params.name, { sampling: req.body.sampling, labels: req.body.labels });
    return (await db.select().from(t.scorers).where(and(eq(t.scorers.factoryId, f.id), eq(t.scorers.name, req.params.name))))[0];
  });
  app.delete('/factories/:id/scorers/:name', { schema: { params: z.object({ id: z.string(), name: z.string() }), response: { 200: Ok } } }, async (req) => { const { f } = await factoryFor(ctx, req, req.params.id, 'factory_owner'); await db.delete(t.scorers).where(and(eq(t.scorers.factoryId, f.id), eq(t.scorers.name, req.params.name))); return { ok: true }; });
  app.get('/factories/:id/scores', { schema: { params: IdP, querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), failing: z.coerce.boolean().optional() }), response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const rows = await s.scoring.recent(f.id, req.query.limit);
    return req.query.failing ? rows.filter((r) => !r.pass) : rows;
  });
  app.post('/runs/:id/score', { schema: { params: IdP, body: z.object({ scorerId: z.string().optional() }).default({}), response: { 200: z.object({ scored: z.number() }) } } }, async (req) => {
    const [r] = await db.select().from(t.runs).where(eq(t.runs.id, req.params.id));
    if (!r) throw notFound('Run');
    await factoryFor(ctx, req, r.factoryId, 'member');
    return { scored: await s.scoring.scoreRun(r.id, { force: true, scorerId: req.body.scorerId }) };
  });

  /* ------------------------------------------------------------- settings */
  app.get('/settings/prices', { schema: { response: { 200: Any } } }, async (req) => { user(req); await seedPrices(db); return db.select().from(t.modelPrices).orderBy(desc(t.modelPrices.effectiveFrom)); });
  app.put('/settings/prices', { schema: { body: z.object({ model: z.string().min(1), inputPerMtok: z.number().min(0), outputPerMtok: z.number().min(0), cachedPerMtok: z.number().min(0).default(0), perPremiumRequest: z.number().min(0).nullable().optional() }), response: { 200: Ok } } }, async (req) => {
    const u = user(req);
    auth.need(u, 'org_admin');
    await db.insert(t.modelPrices).values({ id: ulid(), model: req.body.model, inputPerMtok: req.body.inputPerMtok, outputPerMtok: req.body.outputPerMtok, cachedPerMtok: req.body.cachedPerMtok, perPremiumRequest: req.body.perPremiumRequest ?? null });
    await s.orch.audit(`org:${u.orgId}`, u.id, 'price.updated', req.body.model, req.body).catch(() => undefined);
    return { ok: true };
  });

  app.get('/secrets', { schema: { querystring: z.object({ scope: z.enum(['org', 'factory']).default('org'), factoryId: z.string().optional() }), response: { 200: Any } } }, async (req) => {
    const u = user(req);
    if (req.query.scope === 'factory') { if (!req.query.factoryId) throw invalid('factoryId required'); await factoryFor(ctx, req, req.query.factoryId, 'factory_owner'); return s.secrets.list('factory', req.query.factoryId); }
    auth.need(u, 'org_admin');
    return s.secrets.list('org', u.orgId);
  });
  app.put('/secrets/:name', { schema: { params: z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }), body: z.object({ value: z.string().min(1), scope: z.enum(['org', 'factory']).default('org'), factoryId: z.string().optional() }), response: { 200: Ok } } }, async (req) => {
    const u = user(req);
    if (req.body.scope === 'factory') { if (!req.body.factoryId) throw invalid('factoryId required'); const { f } = await factoryFor(ctx, req, req.body.factoryId, 'factory_owner'); await s.secrets.set('factory', f.id, req.params.name, req.body.value, u.id); await s.orch.audit(f.id, u.id, 'secret.set', req.params.name, { scope: 'factory' }); }
    else { auth.need(u, 'org_admin'); await s.secrets.set('org', u.orgId, req.params.name, req.body.value, u.id); await s.orch.audit(`org:${u.orgId}`, u.id, 'secret.set', req.params.name, { scope: 'org' }).catch(() => undefined); }
    return { ok: true };
  });
  app.delete('/secrets/:name', { schema: { params: z.object({ name: z.string() }), querystring: z.object({ scope: z.enum(['org', 'factory']).default('org'), factoryId: z.string().optional() }), response: { 200: Ok } } }, async (req) => {
    const u = user(req);
    if (req.query.scope === 'factory') { const { f } = await factoryFor(ctx, req, req.query.factoryId ?? '', 'factory_owner'); await s.secrets.delete('factory', f.id, req.params.name); }
    else { auth.need(u, 'org_admin'); await s.secrets.delete('org', u.orgId, req.params.name); }
    return { ok: true };
  });

  /* runners, concurrency, budgets: stored in the definition so it stays the source of truth */
  app.get('/factories/:id/settings', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const a = await s.defs.getActive(f.id);
    const d = a?.definition;
    return {
      identity: { name: f.name, alias: d?.factory.alias ?? f.alias, description: d?.factory.description ?? '', shortPrefix: f.shortPrefix }, limits: d?.factory.limits ?? { maxConcurrentRuns: 4, maxRunsPerRepo: 2 },
      budget: d?.factory.agentDefaults.budget ?? {}, agentDefaults: { harness: d?.factory.agentDefaults.harness ?? null, runner: d?.factory.agentDefaults.runner ?? 'default', maxRunMinutes: d?.factory.agentDefaults.maxRunMinutes ?? 60, idleTimeoutMinutes: d?.factory.agentDefaults.idleTimeoutMinutes ?? 10 },
      runners: Object.entries(d?.runners ?? {}).map(([name, r]) => ({ name, ...r })), gates: d?.gates ?? null, notifications: (f.settings as { notifications?: unknown }).notifications ?? { web: true }, gateway: d?.factory.gateway ?? null, mcpServers: d?.factory.mcpServers ?? {}, secretsDeclared: d?.factory.secrets ?? [], paused: f.paused,
    };
  });
  app.put('/factories/:id/settings', { schema: { params: IdP, body: z.object({ alias: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(), description: z.string().optional(), limits: z.object({ maxConcurrentRuns: z.number().int().positive(), maxRunsPerRepo: z.number().int().positive() }).optional(), budget: z.object({ maxTokensPerRun: z.number().positive().optional(), maxCostPerWorkItemUsd: z.number().positive().optional() }).optional(), agentDefaults: z.object({ runner: z.string().optional(), maxRunMinutes: z.number().positive().optional(), idleTimeoutMinutes: z.number().positive().optional(), harness: z.object({ type: z.enum(['claude-code', 'codex', 'copilot', 'fake']), model: z.string().optional(), reasoning: z.enum(['low', 'medium', 'high']).optional() }).optional() }).optional(), notifications: z.record(z.string(), z.unknown()).optional(), runners: z.record(z.string(), z.object({ description: z.string().optional(), image: z.string(), setupCommands: z.array(z.string()).default([]), resources: z.object({ cpus: z.number().positive(), memoryGb: z.number().positive() }).default({ cpus: 2, memoryGb: 4 }), network: z.object({ egress: z.enum(['allowlist', 'open', 'none']), allow: z.array(z.string()).default([]) }).default({ egress: 'allowlist', allow: [] }) }).nullable()).optional(), gates: z.string().optional() }), response: { 200: z.object({ ok: z.boolean(), issues: z.array(Any), commit: z.string().optional() }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const b = req.body;
    if (b.notifications) await db.update(t.factories).set({ settings: { ...f.settings, notifications: b.notifications }, updatedAt: new Date() }).where(eq(t.factories.id, f.id));
    const needsDef = b.alias !== undefined || b.description !== undefined || b.limits || b.budget || b.agentDefaults || b.runners || b.gates !== undefined;
    if (!needsDef) return { ok: true, issues: [] };
    const files: Files = { ...(await s.defs.getVersion(f.id))!.files };
    const doc = (parseYaml(files['zerovity.factory.yaml']) ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (b.alias !== undefined) doc.alias = b.alias;
    if (b.description !== undefined) doc.description = b.description;
    if (b.limits) doc.limits = b.limits;
    const ad = (doc.agentDefaults ??= {});
    if (b.budget) ad.budget = { ...(ad.budget ?? {}), ...b.budget };
    if (b.agentDefaults) { const { harness, ...rest } = b.agentDefaults; Object.assign(ad, rest); if (harness) ad.harness = { ...(ad.harness ?? {}), ...harness }; }
    files['zerovity.factory.yaml'] = yamlStringify(doc);
    for (const [name, r] of Object.entries(b.runners ?? {})) { if (r === null) delete files[`runners/${name}.yaml`]; else files[`runners/${name}.yaml`] = yamlStringify(r); }
    if (b.gates !== undefined) files['policies/gates.yaml'] = b.gates;
    const r = await s.defs.apply(f.id, files, { message: 'Update settings', by: u.id });
    return { ok: r.ok, issues: r.issues, commit: r.commit };
  });

  /* MCP setup snippets for local coding agents (spec 11.4) */
  app.get('/mcp-setup', { schema: { response: { 200: Any } } }, async (req) => {
    user(req);
    const url = `${ctx.cfg.publicUrl.replace(/\/$/, '')}/mcp`;
    return {
      url,
      snippets: {
        'claude-code': `claude mcp add --transport http zerovity ${url} --header "Authorization: Bearer <your personal access token>"`,
        codex: `# ~/.codex/config.toml\n[mcp_servers.zerovity]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer <your personal access token>" }`,
        copilot: `// ~/.copilot/mcp-config.json\n{\n  "mcpServers": {\n    "zerovity": {\n      "type": "http",\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer <your personal access token>" },\n      "tools": ["*"]\n    }\n  }\n}`,
      },
      note: 'Create a personal access token under Settings > Access tokens. The factory MCP server exposes: list_factories, send_task, list_tasks, search_tasks, get_task, get_conversation, message_foreman, add_context, get_agent_context, validate_definition, get_schema, complete_task.',
    };
  });
}

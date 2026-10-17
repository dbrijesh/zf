import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tables as t } from '@zerovity/db';
import { notFound, invalid, conflict, type ContextItemInput } from '@zerovity/core';
import { agentStats } from '@zerovity/orchestrator';
import { lintSkill, packFromTarball, loadPackDir, diffPacks, effectiveSkills, type SkillFiles } from '@zerovity/skills';
import { serializeFrontmatter, jsonSchemaFor, DOC_SCHEMAS, validateDefinition, type DocName, type Files, parseFrontmatter } from '@zerovity/definition';
import { validateFactory } from '@zerovity/skills';
import { estimateTokens, AgentPhaseSchema, HarnessTypeSchema } from '@zerovity/core';
import { user, factoryFor, type AppCtx } from '../context';
import { ContextS, IdP, Any, Ok } from '../schemas';

const sh = promisify(execFile);

export async function studioRoutes(app0: FastifyInstance, ctx: AppCtx) {
  const app = app0.withTypeProvider<ZodTypeProvider>();
  const { s } = ctx;
  const db = s.db;

  /* ---------------------------------------------------------------- agents */
  const agentView = async (factoryId: string, name: string, stats: Awaited<ReturnType<typeof agentStats>>) => {
    const a = await s.defs.getActive(factoryId);
    const ag = a?.agents.get(name);
    if (!a || !ag) throw notFound('Agent', name);
    const eff = effectiveSkills(name, ag.body, ag.fm.skills, a.sources);
    const override = (a.definition.factory.agentOverrides[name] ?? {}) as Record<string, unknown>;
    const h = s.defs.effectiveHarness(a, ag, null);
    const eff2 = s.defs.effectiveHarness(a, ag);
    return {
      name, source: ag.source, description: ag.fm.description, phase: ag.fm.phase, role: ag.fm.role ?? null, harness: h, effectiveHarness: eff2.type, forced: eff2.type !== h.type, runner: ag.fm.runner ?? a.definition.factory.agentDefaults.runner ?? 'default',
      contextScopes: ag.fm.contextScopes, outputs: ag.fm.outputs, mcpServers: ag.fm.mcpServers, credential: ag.fm.credential ?? null, secrets: ag.fm.secrets, maxRunMinutes: ag.fm.maxRunMinutes ?? null, body: ag.body, bodyLines: ag.body.replace(/\n+$/, '').split('\n').length,
      skills: eff.skills.map((x) => ({ name: x.name, layer: x.layer, source: x.source, overrides: x.overrides ?? [], description: x.description, tokens: x.tokens })), missingSkills: eff.missing, weight: eff.weight, overridden: Object.keys(override), stats: stats[name] ?? null,
    };
  };

  app.get('/factories/:id/agents', { schema: { params: IdP, response: { 200: z.array(Any) } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const a = await s.defs.getActive(f.id);
    const stats = await agentStats(db, f.id);
    return Promise.all([...(a?.agents.keys() ?? [])].sort().map((n) => agentView(f.id, n, stats)));
  });
  app.get('/factories/:id/agents/:name', { schema: { params: z.object({ id: z.string(), name: z.string() }), response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    return agentView(f.id, req.params.name, await agentStats(db, f.id));
  });

  const AgentPatch = z.object({
    description: z.string().max(200).optional(), phase: AgentPhaseSchema.optional(), role: z.string().optional(), skills: z.array(z.string()).optional(), contextScopes: z.array(z.enum(['org', 'factory', 'repo', 'workItem', 'phase'])).optional(),
    harness: z.object({ type: HarnessTypeSchema.optional(), model: z.string().optional(), reasoning: z.enum(['low', 'medium', 'high']).optional() }).optional(), outputs: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(), credential: z.string().nullable().optional(), runner: z.string().optional(), maxRunMinutes: z.number().positive().optional(), body: z.string().optional(), fork: z.boolean().optional(),
  });
  app.put('/factories/:id/agents/:name', { schema: { params: z.object({ id: z.string(), name: z.string() }), body: AgentPatch, response: { 200: z.object({ ok: z.boolean(), commit: z.string().optional(), issues: z.array(Any) }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const a = await s.defs.getActive(f.id);
    const ag = a?.agents.get(req.params.name);
    if (!a || !ag) throw notFound('Agent', req.params.name);
    const { body, fork, ...fm } = req.body;
    const v = await s.defs.getVersion(f.id);
    const files: Files = { ...v!.files };
    const wantsBody = body !== undefined && body !== ag.body;
    if (ag.source === 'factory' || fork || wantsBody) {
      // factory agents (and forked pack agents) are real files; edit frontmatter + body in place
      const file = `agents/${req.params.name}/agent.md`;
      const cur = parseFrontmatter(files[file] ?? '', file);
      const data = { ...(files[file] ? cur.data : { ...ag.fm }) } as Record<string, unknown>;
      for (const [k, val] of Object.entries(fm)) { if (val === undefined) continue; if (val === null) delete data[k]; else data[k] = k === 'harness' ? { ...((data.harness as object) ?? {}), ...(val as object) } : val; }
      files[file] = serializeFrontmatter(data, body ?? (files[file] ? cur.body : ag.body), (o) => yamlStringify(o));
      // drop an override for this agent: the file now carries the config
      const doc = parseYaml(files['zerovity.factory.yaml']) as Record<string, unknown>;
      if ((doc.agentOverrides as Record<string, unknown> | undefined)?.[req.params.name]) { delete (doc.agentOverrides as Record<string, unknown>)[req.params.name]; files['zerovity.factory.yaml'] = yamlStringify(doc); }
    } else {
      const r = await s.defs.setAgentOverride(f.id, req.params.name, { ...fm, credential: fm.credential === null ? undefined : fm.credential } as never, u.id);
      return { ok: r.ok, commit: r.commit, issues: r.issues };
    }
    const r = await s.defs.apply(f.id, files, { message: `Edit agent ${req.params.name}`, by: u.id });
    return { ok: r.ok, commit: r.commit, issues: r.issues };
  });
  app.post('/factories/:id/agents', { schema: { params: IdP, body: z.object({ name: z.string().regex(/^[a-z][a-z0-9-]*$/), description: z.string().min(1).max(200), phase: AgentPhaseSchema, copyFrom: z.string().optional() }), response: { 200: z.object({ ok: z.boolean(), issues: z.array(Any) }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const a = await s.defs.getActive(f.id);
    if (a?.agents.has(req.body.name)) throw conflict('An agent with that name already exists');
    const src = req.body.copyFrom ? a?.agents.get(req.body.copyFrom) : undefined;
    const data = { ...(src?.fm ?? { skills: [], contextScopes: ['org', 'factory', 'repo', 'workItem'], outputs: [], spawnableBy: ['foreman'] }), description: req.body.description, phase: req.body.phase };
    const files: Files = { ...(await s.defs.getVersion(f.id))!.files, [`agents/${req.body.name}/agent.md`]: serializeFrontmatter(data as Record<string, unknown>, src?.body ?? `You work the ${req.body.phase} phase. Describe the role here and keep procedures in skills.\n`, (o) => yamlStringify(o)) };
    const r = await s.defs.apply(f.id, files, { message: `Add agent ${req.body.name}`, by: u.id });
    return { ok: r.ok, issues: r.issues };
  });
  app.delete('/factories/:id/agents/:name', { schema: { params: z.object({ id: z.string(), name: z.string() }), response: { 200: z.object({ ok: z.boolean(), issues: z.array(Any) }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const files: Files = { ...(await s.defs.getVersion(f.id))!.files };
    const keys = Object.keys(files).filter((k) => k.startsWith(`agents/${req.params.name}/`));
    if (!keys.length) throw invalid('Only agents defined in this factory can be deleted; pack agents can be overridden instead');
    for (const k of keys) delete files[k];
    const r = await s.defs.apply(f.id, files, { message: `Remove agent ${req.params.name}`, by: u.id });
    return { ok: r.ok, issues: r.issues };
  });
  app.post('/factories/:id/agents/:name/test', { schema: { params: z.object({ id: z.string(), name: z.string() }), body: z.object({ title: z.string().default('Sample request'), body: z.string().default('Add a health check endpoint that returns the build version.') }).default({ title: 'Sample request', body: 'Add a health check endpoint that returns the build version.' }), response: { 200: z.object({ workItemId: z.string(), runId: z.string() }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'member');
    return s.orch.testRun(f.id, req.params.name, req.body, u.id);
  });

  /* ---------------------------------------------------------------- skills */
  const lint = (name: string, files: SkillFiles, label: string) => lintSkill(files, label);

  app.get('/factories/:id/skills', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const a = await s.defs.getActive(f.id);
    if (!a) return { skills: [], packs: [] };
    const used: Record<string, string[]> = {};
    for (const ag of a.agents.values()) { const e = effectiveSkills(ag.name, ag.body, ag.fm.skills, a.sources); for (const sk of e.skills) (used[sk.name] ??= []).push(ag.name); }
    const rows: unknown[] = [];
    const push = (scope: string, source: string, name: string, files: SkillFiles) => {
      const rep = lint(name, files, `${scope}/${name}`);
      const meta = (parseFrontmatter(files['SKILL.md'] ?? '', 'SKILL.md').data.zerovity ?? {}) as { version?: string; phases?: string[] };
      rows.push({ name, scope, source, description: rep.name ? ((parseFrontmatter(files['SKILL.md'] ?? '', 'x').data.description as string) ?? '') : '', version: meta.version ?? '', phases: meta.phases ?? [], tokens: rep.tokens, bodyLines: rep.bodyLines, errors: rep.issues.filter((i) => i.severity === 'error').length, warnings: rep.issues.filter((i) => i.severity === 'warning').length, usedBy: used[name] ?? [], files: Object.keys(files).filter((x) => x !== 'SKILL.md') });
    };
    for (const p of a.sources.packs) for (const [n, fl] of Object.entries(p.skills)) push('pack', p.manifest.name, n, fl);
    for (const [n, fl] of Object.entries(a.sources.factory)) push('factory', 'factory', n, fl);
    for (const [ag, set] of Object.entries(a.sources.agent)) for (const [n, fl] of Object.entries(set)) push(`agent:${ag}`, `agent:${ag}`, n, fl);
    return { skills: rows, packs: a.sources.packs.map((p) => ({ name: p.manifest.name, version: p.manifest.version, hash: p.hash })) };
  });

  app.get('/factories/:id/skills/:name', { schema: { params: z.object({ id: z.string(), name: z.string() }), querystring: z.object({ scope: z.string().default('factory') }), response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const a = await s.defs.getActive(f.id);
    if (!a) throw notFound('Definition');
    const { scope } = req.query;
    // a pack skill is addressed as "pack:<pack name>"; a bare "pack" means the first pack that has it
    const files = scope === 'factory' ? a.sources.factory[req.params.name] : scope.startsWith('agent:') ? a.sources.agent[scope.slice(6)]?.[req.params.name] : a.sources.packs.find((p) => (scope === 'pack' ? !!p.skills[req.params.name] : scope === `pack:${p.manifest.name}`))?.skills[req.params.name];
    if (!files) throw notFound('Skill', req.params.name);
    return { name: req.params.name, scope, files, lint: lint(req.params.name, files, `${scope}/${req.params.name}`), editable: !scope.startsWith('pack:') };
  });

  /** Live lint for the editor: nothing is saved. */
  app.post('/skills/lint', { schema: { body: z.object({ name: z.string(), files: z.record(z.string(), z.string()) }), response: { 200: Any } } }, async (req) => {
    user(req);
    const r = lint(req.body.name, req.body.files, `skills/${req.body.name}`);
    return { ...r, weight: { body: r.tokens.body, description: r.tokens.description, loadedAlways: r.tokens.description } };
  });

  app.put('/factories/:id/skills/:name', { schema: { params: z.object({ id: z.string(), name: z.string().regex(/^[a-z][a-z0-9-]*$/) }), body: z.object({ scope: z.string().default('factory'), files: z.record(z.string(), z.string()) }), response: { 200: z.object({ ok: z.boolean(), issues: z.array(Any) }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const base = req.body.scope === 'factory' ? `skills/${req.params.name}` : req.body.scope.startsWith('agent:') ? `agents/${req.body.scope.slice(6)}/skills/${req.params.name}` : '';
    if (!base) throw invalid('Pack skills are read-only: fork it into the factory first');
    const files: Files = { ...(await s.defs.getVersion(f.id))!.files };
    for (const k of Object.keys(files)) if (k.startsWith(base + '/')) delete files[k];
    for (const [p, c] of Object.entries(req.body.files)) { if (p.includes('..')) throw invalid('bad path'); files[`${base}/${p}`] = c; }
    const r = await s.defs.apply(f.id, files, { message: `Edit skill ${req.params.name}`, by: u.id });
    return { ok: r.ok, issues: r.issues };
  });
  app.post('/factories/:id/skills/:name/fork', { schema: { params: z.object({ id: z.string(), name: z.string() }), body: z.object({ from: z.string() }), response: { 200: z.object({ ok: z.boolean(), issues: z.array(Any) }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const a = await s.defs.getActive(f.id);
    const pack = a?.sources.packs.find((p) => req.body.from === `pack:${p.manifest.name}`);
    const src = pack?.skills[req.params.name];
    if (!src) throw notFound('Skill', req.params.name);
    const files: Files = { ...(await s.defs.getVersion(f.id))!.files };
    for (const [p, c] of Object.entries(src)) files[`skills/${req.params.name}/${p}`] = c;
    const r = await s.defs.apply(f.id, files, { message: `Fork skill ${req.params.name} from ${pack!.manifest.name}`, by: u.id });
    return { ok: r.ok, issues: r.issues };
  });
  app.delete('/factories/:id/skills/:name', { schema: { params: z.object({ id: z.string(), name: z.string() }), querystring: z.object({ scope: z.string().default('factory') }), response: { 200: z.object({ ok: z.boolean(), issues: z.array(Any) }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const base = req.query.scope === 'factory' ? `skills/${req.params.name}/` : req.query.scope.startsWith('agent:') ? `agents/${req.query.scope.slice(6)}/skills/${req.params.name}/` : '';
    if (!base) throw invalid('Pack skills cannot be deleted');
    const files: Files = { ...(await s.defs.getVersion(f.id))!.files };
    for (const k of Object.keys(files)) if (k.startsWith(base)) delete files[k];
    const r = await s.defs.apply(f.id, files, { message: `Remove skill ${req.params.name}`, by: u.id });
    return { ok: r.ok, issues: r.issues };
  });

  /* ---------------------------------------------------------------- packs */
  app.get('/packs', { schema: { response: { 200: Any } } }, async (req) => {
    user(req);
    const rows = await db.select().from(t.packs).orderBy(t.packs.name);
    return rows.map((r) => ({ id: r.id, name: r.name, version: r.version, description: r.description, hash: r.hash, skillCount: r.skillCount, agentCount: r.agentCount, source: r.source, createdAt: r.createdAt }));
  });
  app.get('/packs/:name/:version', { schema: { params: z.object({ name: z.string(), version: z.string() }), response: { 200: Any } } }, async (req) => {
    user(req);
    const p = await s.packs.get(req.params.name, req.params.version);
    if (!p) throw notFound('Pack', `${req.params.name}@${req.params.version}`);
    return { manifest: p.manifest, hash: p.hash, skills: Object.entries(p.skills).map(([n, fl]) => { const r = lintSkill(fl, `${p.manifest.name}/skills/${n}`); return { name: n, description: (parseFrontmatter(fl['SKILL.md'] ?? '', n).data.description as string) ?? '', tokens: r.tokens, errors: r.issues.filter((i) => i.severity === 'error').length }; }), agents: Object.keys(p.agents) };
  });
  app.post('/packs/import', { schema: { querystring: z.object({ gitUrl: z.string().optional(), ref: z.string().optional(), subdir: z.string().optional() }), response: { 200: Any } } }, async (req) => {
    const u = user(req);
    ctx.auth.need(u, 'org_admin');
    let pack;
    if (req.query.gitUrl) {
      if (!/^(https:\/\/|git@|ssh:\/\/)/.test(req.query.gitUrl)) throw invalid('Only https or ssh Git URLs are accepted');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pack-git-'));
      try {
        await sh('git', ['clone', '--depth', '1', ...(req.query.ref ? ['--branch', req.query.ref] : []), '--', req.query.gitUrl, dir], { timeout: 120_000 });
        pack = loadPackDir(path.join(dir, req.query.subdir ?? ''));
      } catch (e) { throw invalid(`Could not import from Git: ${(e as Error).message.split('\n')[0]}`); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    } else {
      const file = await req.file();
      if (!file) throw invalid('Upload a pack tarball (.tgz) or pass gitUrl');
      pack = await packFromTarball(await file.toBuffer());
    }
    const bad = Object.entries(pack.skills).map(([n, fl]) => ({ n, errs: lintSkill(fl, `${pack.manifest.name}/skills/${n}`).issues.filter((i) => i.severity === 'error') })).filter((x) => x.errs.length);
    await s.packs.install(pack, req.query.gitUrl ? `git:${req.query.gitUrl}` : 'tarball');
    await s.orch.audit(`org:${u.orgId}`, u.id, 'pack.imported', `${pack.manifest.name}@${pack.manifest.version}`, { hash: pack.hash }).catch(() => undefined);
    return { name: pack.manifest.name, version: pack.manifest.version, hash: pack.hash, lintErrors: bad.map((b) => ({ skill: b.n, errors: b.errs.map((e) => e.message) })) };
  });
  app.post('/factories/:id/packs/preview-upgrade', { schema: { params: IdP, body: z.object({ name: z.string(), version: z.string().optional() }), response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const a = await s.defs.getActive(f.id);
    const cur = a?.sources.packs.find((p) => p.manifest.name === req.body.name);
    const list = (await db.select().from(t.packs).where(eq(t.packs.name, req.body.name))).map((r) => r.version);
    const target = await s.packs.get(req.body.name, req.body.version ?? (await s.packs.resolve(req.body.name, '*'))?.manifest.version ?? '');
    if (!target) throw notFound('Pack', req.body.name);
    return { current: cur?.manifest.version ?? null, target: target.manifest.version, available: list, diff: cur ? diffPacks(cur, target) : null };
  });
  app.post('/factories/:id/packs/upgrade', { schema: { params: IdP, body: z.object({ name: z.string(), version: z.string() }), response: { 200: z.object({ ok: z.boolean(), issues: z.array(Any), commit: z.string().optional() }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const target = await s.packs.get(req.body.name, req.body.version);
    if (!target) throw notFound('Pack', `${req.body.name}@${req.body.version}`);
    const files: Files = { ...(await s.defs.getVersion(f.id))!.files };
    const doc = parseYaml(files['zerovity.factory.yaml']) as { packs?: Array<{ name: string; version: string }> };
    doc.packs = (doc.packs ?? []).filter((p) => p.name !== req.body.name).concat([{ name: req.body.name, version: `^${req.body.version}` }]);
    files['zerovity.factory.yaml'] = yamlStringify(doc);
    delete files['zerovity.lock']; // re-resolved by apply
    const r = await s.defs.apply(f.id, files, { message: `Upgrade ${req.body.name} to ${req.body.version}`, by: u.id });
    return { ok: r.ok, issues: r.issues, commit: r.commit };
  });

  /* ---------------------------------------------------------------- context library */
  app.get('/context', { schema: { querystring: z.object({ layer: z.string().optional(), scopeId: z.string().optional(), kind: z.string().optional(), tag: z.string().optional(), q: z.string().optional(), factoryId: z.string().optional(), workItemId: z.string().optional() }), response: { 200: z.array(ContextS) } } }, async (req) => {
    const u = user(req);
    const q = req.query;
    let scopes: Array<{ layer: string; scopeId: string }> | undefined;
    if (q.factoryId) { await factoryFor(ctx, req, q.factoryId); scopes = [{ layer: 'org', scopeId: u.orgId }, { layer: 'factory', scopeId: q.factoryId }]; }
    if (q.workItemId) scopes = [...(scopes ?? []), { layer: 'workItem', scopeId: q.workItemId }];
    return s.contexts.list({ orgId: u.orgId, layer: scopes ? undefined : q.layer, scopeId: scopes ? undefined : q.scopeId, kind: q.kind, tag: q.tag, q: q.q, scopes: q.layer && scopes ? scopes.filter((x) => x.layer === q.layer) : scopes });
  });
  app.get('/context/:id', { schema: { params: IdP, response: { 200: Any } } }, async (req) => { const u = user(req); const it = await s.contexts.get(req.params.id); if (it.orgId !== u.orgId) throw notFound('Context item'); return it; });
  const CtxIn = z.object({ layer: z.enum(['org', 'factory', 'repo', 'workItem', 'phase']), scopeId: z.string().default(''), title: z.string().min(1).max(200), kind: z.enum(['note', 'glossary', 'adr', 'repoPointer', 'ticket']).default('note'), body: z.string().default(''), tags: z.array(z.string()).default([]), priority: z.enum(['always', 'relevant', 'on_request']).default('always'), appliesTo: z.object({ phases: z.array(AgentPhaseSchema).default([]), agents: z.array(z.string()).default([]) }).default({ phases: [], agents: [] }), meta: z.record(z.string(), z.unknown()).default({}) });
  const needForLayer = async (req: Parameters<typeof user>[0], layer: string, scopeId: string) => {
    const u = user(req);
    if (layer === 'org') ctx.auth.need(u, 'org_admin');
    else if (layer === 'factory') await factoryFor(ctx, req, scopeId, 'factory_owner');
    else if (layer === 'repo') ctx.auth.need(u, 'factory_owner');
    else ctx.auth.need(u, 'member');
    return u;
  };
  app.post('/context', { schema: { body: CtxIn, response: { 200: ContextS } } }, async (req) => { const u = await needForLayer(req, req.body.layer, req.body.scopeId); return s.contexts.create(u.orgId, req.body as ContextItemInput, u.id); });
  app.post('/context/url', { schema: { body: z.object({ layer: z.enum(['org', 'factory', 'repo', 'workItem', 'phase']), scopeId: z.string().default(''), url: z.string().url(), title: z.string().optional(), priority: z.enum(['always', 'relevant', 'on_request']).optional(), tags: z.array(z.string()).optional() }), response: { 200: ContextS } } }, async (req) => { const u = await needForLayer(req, req.body.layer, req.body.scopeId); return s.contexts.attachUrl(u.orgId, req.body, u.id); });
  app.post('/context/file', { schema: { querystring: z.object({ layer: z.enum(['org', 'factory', 'repo', 'workItem', 'phase']), scopeId: z.string().default(''), priority: z.enum(['always', 'relevant', 'on_request']).optional(), title: z.string().optional() }), response: { 200: ContextS } } }, async (req) => {
    const u = await needForLayer(req, req.query.layer, req.query.scopeId);
    const file = await req.file();
    if (!file) throw invalid('A file is required');
    return s.contexts.attachFile(u.orgId, { layer: req.query.layer, scopeId: req.query.scopeId, name: file.filename, data: await file.toBuffer(), priority: req.query.priority, title: req.query.title }, u.id);
  });
  app.patch('/context/:id', { schema: { params: IdP, body: z.object({ title: z.string().optional(), body: z.string().optional(), tags: z.array(z.string()).optional(), priority: z.enum(['always', 'relevant', 'on_request']).optional(), appliesTo: z.object({ phases: z.array(z.string()), agents: z.array(z.string()) }).optional(), enabled: z.boolean().optional() }), response: { 200: ContextS } } }, async (req) => {
    const it = await s.contexts.get(req.params.id);
    const u = await needForLayer(req, it.layer, it.scopeId);
    if (it.orgId !== u.orgId) throw notFound('Context item');
    return s.contexts.update(req.params.id, req.body, u.id);
  });
  app.delete('/context/:id', { schema: { params: IdP, response: { 200: Ok } } }, async (req) => { const it = await s.contexts.get(req.params.id); const u = await needForLayer(req, it.layer, it.scopeId); await s.contexts.remove(req.params.id, u.id); return { ok: true }; });
  app.post('/context/:id/refresh', { schema: { params: IdP, response: { 200: ContextS } } }, async (req) => { const it = await s.contexts.get(req.params.id); const u = await needForLayer(req, it.layer, it.scopeId); return s.contexts.refreshUrl(req.params.id, u.id); });
  app.get('/context/:id/versions', { schema: { params: IdP, response: { 200: Any } } }, async (req) => { const it = await s.contexts.get(req.params.id); if (it.orgId !== user(req).orgId) throw notFound('Context item'); return s.contexts.versions(req.params.id); });
  app.post('/context/:id/restore', { schema: { params: IdP, body: z.object({ version: z.number().int() }), response: { 200: ContextS } } }, async (req) => { const it = await s.contexts.get(req.params.id); const u = await needForLayer(req, it.layer, it.scopeId); return s.contexts.restoreVersion(req.params.id, req.body.version, u.id); });
  app.get('/context/:id/original', { schema: { params: IdP } }, async (req, reply) => {
    const it = await s.contexts.get(req.params.id);
    if (it.orgId !== user(req).orgId) throw notFound('Context item');
    const f = await s.contexts.originalFile(req.params.id);
    if (!f) throw notFound('Original file');
    return reply.header('content-disposition', `attachment; filename="${f.name.replace(/"/g, '')}"`).header('content-type', 'application/octet-stream').send(f.data);
  });

  /** "What the agent sees": assembled CONTEXT.md and per-item token costs for any agent and phase. */
  app.get('/work-items/:id/context/preview', { schema: { params: IdP, querystring: z.object({ agent: z.string().optional(), phase: z.string().optional() }), response: { 200: Any } } }, async (req) => {
    const [w] = await db.select().from(t.workItems).where(eq(t.workItems.id, req.params.id));
    if (!w) throw notFound('Work item');
    const { f } = await factoryFor(ctx, req, w.factoryId);
    const a = await s.defs.getActive(f.id);
    const ag = (req.query.agent ? a?.agents.get(req.query.agent) : a && s.defs.agentForPhase(a, req.query.phase ?? w.phase ?? 'INTENT')) ?? [...(a?.agents.values() ?? [])][0];
    if (!ag) throw notFound('Agent');
    const bundle = await s.contexts.preview(w.id, { name: ag.name, phase: req.query.phase ?? ag.fm.phase, contextScopes: ag.fm.contextScopes, tokenBudget: ag.fm.contextTokenBudget });
    return { agent: ag.name, phase: req.query.phase ?? ag.fm.phase, ...bundle };
  });
  app.put('/work-items/:id/context/toggles', { schema: { params: IdP, body: z.object({ itemId: z.string(), enabled: z.boolean() }), response: { 200: Ok } } }, async (req) => {
    const [w] = await db.select().from(t.workItems).where(eq(t.workItems.id, req.params.id));
    if (!w) throw notFound('Work item');
    await factoryFor(ctx, req, w.factoryId, 'member');
    await s.contexts.setToggle(w.id, req.body.itemId, req.body.enabled);
    return { ok: true };
  });
  app.get('/agents/:name/context/preview', { schema: { params: z.object({ name: z.string() }), querystring: z.object({ factoryId: z.string(), phase: z.string().optional(), workItemId: z.string().optional() }), response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.query.factoryId);
    const a = await s.defs.getActive(f.id);
    const ag = a?.agents.get(req.params.name);
    if (!ag) throw notFound('Agent');
    const [w] = req.query.workItemId ? await db.select().from(t.workItems).where(eq(t.workItems.id, req.query.workItemId)) : await db.select().from(t.workItems).where(eq(t.workItems.factoryId, f.id)).orderBy(t.workItems.createdAt).limit(1);
    if (!w) return { agent: ag.name, contextMd: '(no work item yet: create one to preview its context)', report: [], tokens: 0, budget: 12000, items: {}, trimmed: false, bundleHash: '' };
    return { agent: ag.name, ...(await s.contexts.preview(w.id, { name: ag.name, phase: req.query.phase ?? ag.fm.phase, contextScopes: ag.fm.contextScopes, tokenBudget: ag.fm.contextTokenBudget })) };
  });

  /* ---------------------------------------------------------------- definition */
  app.get('/factories/:id/definition', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const v = await s.defs.getVersion(f.id, f.definitionCommit ?? undefined);
    const latest = await s.defs.getVersion(f.id);
    return { commit: f.definitionCommit, source: f.definitionSource, repo: f.definitionRepo, readOnly: f.definitionSource === 'git', files: v?.files ?? {}, valid: v?.valid ?? false, issues: latest?.issues ?? [], latestCommit: latest?.commit, latestValid: latest?.valid ?? false, history: await s.defs.history(f.id) };
  });
  app.get('/factories/:id/definition/versions/:commit', { schema: { params: z.object({ id: z.string(), commit: z.string() }), response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const v = await s.defs.getVersion(f.id, req.params.commit);
    if (!v) throw notFound('Version', req.params.commit);
    return { commit: v.commit, files: v.files, valid: v.valid, issues: v.issues, message: v.message, appliedAt: v.appliedAt };
  });
  app.put('/factories/:id/definition', { schema: { params: IdP, body: z.object({ files: z.record(z.string(), z.string().nullable()), message: z.string().max(300).default('Edit definition') }), response: { 200: z.object({ ok: z.boolean(), commit: z.string(), issues: z.array(Any), applied: z.boolean() }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    if (f.definitionSource === 'git') throw conflict('This factory is Git-backed: change the definition repository (a PR) instead', { repo: f.definitionRepo });
    const files: Files = { ...(await s.defs.getVersion(f.id, f.definitionCommit ?? undefined))!.files };
    for (const [p, c] of Object.entries(req.body.files)) { if (p.includes('..') || p.startsWith('/')) throw invalid(`bad path ${p}`); if (c === null) delete files[p]; else files[p] = c; }
    const r = await s.defs.apply(f.id, files, { message: req.body.message, by: u.id });
    return { ok: r.ok, commit: r.commit, issues: r.issues, applied: r.applied };
  });
  app.post('/factories/:id/definition/validate', { schema: { params: IdP, body: z.object({ files: z.record(z.string(), z.string().nullable()) }), response: { 200: z.object({ ok: z.boolean(), issues: z.array(Any), agents: z.record(z.string(), Any) }) } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const files: Files = { ...(await s.defs.getVersion(f.id, f.definitionCommit ?? undefined))!.files };
    for (const [p, c] of Object.entries(req.body.files)) { if (c === null) delete files[p]; else files[p] = c; }
    const v = await validateFactory(files, s.packs);
    return { ok: v.ok, issues: v.issues, agents: Object.fromEntries(Object.entries(v.agentSkills).map(([k, e]) => [k, { weight: e.weight, skills: e.skills.map((x) => x.name), missing: e.missing }])) };
  });
  app.post('/factories/:id/definition/rollback', { schema: { params: IdP, body: z.object({ commit: z.string() }), response: { 200: z.object({ ok: z.boolean(), commit: z.string(), issues: z.array(Any) }) } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const v = await s.defs.getVersion(f.id, req.body.commit);
    if (!v) throw notFound('Version', req.body.commit);
    const r = await s.defs.apply(f.id, v.files, { message: `Roll back to ${v.commit}`, by: u.id });
    return { ok: r.ok, commit: r.commit, issues: r.issues };
  });
  app.post('/factories/:id/definition/sync', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    if (f.definitionSource !== 'git') throw invalid('Only Git-backed factories can sync');
    const { syncDefinitionFromGit } = await import('@zerovity/orchestrator');
    const r = await syncDefinitionFromGit(s, ctx.forges, f.id, u.id);
    return { ok: r.ok, commit: r.commit, issues: r.issues };
  });
  app.get('/schemas/zf/v1alpha1/:doc', { schema: { params: z.object({ doc: z.string() }) } }, async (req, reply) => {
    const name = req.params.doc.replace(/\.json$/, '') as DocName;
    if (!(name in DOC_SCHEMAS)) throw notFound('Schema', req.params.doc);
    return reply.header('content-type', 'application/schema+json').header('cache-control', 'public, max-age=300').send(jsonSchemaFor(name));
  });
  void estimateTokens; void validateDefinition;
}

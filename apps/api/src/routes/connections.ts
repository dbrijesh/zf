import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { tables as t } from '@zerovity/db';
import { notFound, invalid, randomToken } from '@zerovity/core';
import { jiraAuthorizeUrl, jiraExchangeCode, jiraAccessibleSites } from '@zerovity/tracker';
import { signSession, verifySession } from '../auth';
import { user, factoryFor, type AppCtx } from '../context';
import { IdP, Any, Ok } from '../schemas';

const popupDone = (ok: boolean, msg: string, id?: string) => `<!doctype html><meta charset="utf-8"><title>Connection</title><body style="font:15px system-ui;padding:32px;background:#24324b;color:#ece6d8"><p>${msg.replace(/[<>&]/g, '')}</p><script>try{window.opener&&window.opener.postMessage({type:'zf-oauth',ok:${ok},connectionId:${JSON.stringify(id ?? null)}},location.origin)}catch(e){}${ok ? 'setTimeout(()=>window.close(),400)' : ''}</script></body>`;

export async function connectionRoutes(app0: FastifyInstance, ctx: AppCtx) {
  const app = app0.withTypeProvider<ZodTypeProvider>();
  const { s, auth, conns } = ctx;
  const db = s.db;
  const own = async (req: Parameters<typeof user>[0], id: string) => {
    const u = user(req);
    const c = await conns.get(id);
    if (c.orgId !== u.orgId) throw notFound('Connection', id);
    return { c, u };
  };

  app.get('/connections', { schema: { response: { 200: z.array(Any) } } }, async (req) => conns.list(user(req).orgId));
  app.get('/connections/catalogue', { schema: { response: { 200: z.array(Any) } } }, async (req) => { user(req); return conns.catalogue(); });
  app.get('/connections/:id', { schema: { params: IdP, response: { 200: Any } } }, async (req) => { const { c } = await own(req, req.params.id); return conns.view(c, true); });

  app.post('/connections', { schema: { body: z.object({ typeId: z.string(), displayName: z.string().min(1).max(80), values: z.record(z.string(), z.string()).default({}) }), response: { 200: Any } } }, async (req) => {
    const u = user(req);
    auth.need(u, 'org_admin');
    const ct = conns.catalogue().find((x) => x.id === req.body.typeId);
    if (ct?.type === 'identity') auth.need(u, 'org_admin');
    const values = { ...req.body.values };
    if (req.body.typeId === 'jira-dc' || req.body.typeId === 'jira-cloud') values.webhookToken ??= randomToken(16);
    const v = await conns.create(u.orgId, { typeId: req.body.typeId, displayName: req.body.displayName, values, by: u.id });
    if (values.webhookToken) await db.update(t.connections).set({ config: { ...(await conns.get(v.id)).config, webhookToken: values.webhookToken } }).where(eq(t.connections.id, v.id));
    return conns.view(await conns.get(v.id));
  });
  app.post('/connections/:id/test', { schema: { params: IdP, response: { 200: z.object({ ok: z.boolean(), detail: z.string(), status: z.string() }) } } }, async (req) => { const { u } = await own(req, req.params.id); auth.need(u, 'factory_owner'); return conns.test(req.params.id, u.id); });
  app.post('/connections/:id/rotate', { schema: { params: IdP, body: z.object({ values: z.record(z.string(), z.string()) }), response: { 200: Any } } }, async (req) => { const { u } = await own(req, req.params.id); auth.need(u, 'org_admin'); return conns.rotate(req.params.id, req.body.values, u.id); });
  app.delete('/connections/:id', { schema: { params: IdP, querystring: z.object({ force: z.coerce.boolean().default(false) }), response: { 200: Any } } }, async (req) => { const { u } = await own(req, req.params.id); auth.need(u, 'org_admin'); return conns.remove(req.params.id, u.id, req.query.force); });
  app.post('/connections/check-all', { schema: { response: { 200: Any } } }, async (req) => { const u = user(req); auth.need(u, 'org_admin'); return conns.checkAll(u.orgId); });

  /* searchable pickers for the per-factory mapping */
  app.get('/connections/:id/repos', { schema: { params: IdP, querystring: z.object({ q: z.string().optional() }), response: { 200: Any } } }, async (req) => {
    const { c } = await own(req, req.params.id);
    if (c.type !== 'forge') throw invalid('Not a code forge connection');
    return (await (await conns.githubForge(c)).listRepos(req.query.q)).slice(0, 200);
  });
  app.get('/connections/:id/projects', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const { c } = await own(req, req.params.id);
    if (c.type !== 'tracker') throw invalid('Not an issue tracker connection');
    return (await conns.jiraClient(c)).listProjects();
  });

  /* per-factory mapping: writes back into the definition (or opens a PR for Git-backed factories) */
  app.get('/factories/:id/connections', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const { f } = await factoryFor(ctx, req, req.params.id);
    const rows = await db.select({ m: t.factoryConnections, c: t.connections }).from(t.factoryConnections).innerJoin(t.connections, eq(t.factoryConnections.connectionId, t.connections.id)).where(eq(t.factoryConnections.factoryId, f.id));
    const a = await s.defs.getActive(f.id);
    return { mapped: await Promise.all(rows.map(async (r) => ({ ...(await conns.view(r.c)), mapping: r.m.mapping }))), repositories: a?.definition.factory.repositories ?? [], jira: a?.definition.factory.integrations?.jira ?? [], agents: [...(a?.agents.values() ?? [])].map((x) => ({ name: x.name, credential: x.fm.credential ?? null, mcpServers: x.fm.mcpServers, harness: s.defs.effectiveHarness(a!, x).type })), mcpServers: Object.keys(a?.definition.factory.mcpServers ?? {}) };
  });
  app.put('/factories/:id/connections/:cid', { schema: { params: z.object({ id: z.string(), cid: z.string() }), body: z.object({ mapping: z.record(z.string(), z.unknown()) }), response: { 200: Any } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    const c = await conns.get(req.params.cid);
    if (c.orgId !== f.orgId) throw notFound('Connection');
    return conns.mapFactory(f.id, c.id, req.body.mapping, u.id);
  });
  app.delete('/factories/:id/connections/:cid', { schema: { params: z.object({ id: z.string(), cid: z.string() }), response: { 200: Ok } } }, async (req) => { const { f } = await factoryFor(ctx, req, req.params.id, 'factory_owner'); await db.delete(t.factoryConnections).where(and(eq(t.factoryConnections.factoryId, f.id), eq(t.factoryConnections.connectionId, req.params.cid))); return { ok: true }; });
  app.put('/factories/:id/agents/:name/assignment', { schema: { params: z.object({ id: z.string(), name: z.string() }), body: z.object({ credential: z.string().nullable().optional(), mcpServers: z.array(z.string()).optional() }), response: { 200: Any } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.params.id, 'factory_owner');
    return conns.assignAgent(f.id, req.params.name, req.body, u.id);
  });

  /* ---------------- popup flows ---------------- */
  app.post('/connections/:id/authorize', { schema: { params: IdP, response: { 200: z.object({ url: z.string() }) } } }, async (req) => {
    const { c, u } = await own(req, req.params.id);
    auth.need(u, 'org_admin');
    const state = signSession(auth.secret, { uid: `oauth:${c.id}:${u.id}`, exp: Date.now() + 10 * 60_000 });
    const cfg = c.config as Record<string, string>;
    if (c.provider === 'jira-cloud') return { url: jiraAuthorizeUrl({ clientId: cfg.clientId, redirectUri: `${ctx.cfg.publicUrl}/api/v1/connections/oauth/jira/callback`, state }) };
    if (c.provider === 'github') {
      const app0 = await conns.githubApp(c);
      const info = await app0.asApp<{ slug: string; html_url: string }>('GET', '/app');
      return { url: `${app0.webBase}/apps/${info.slug}/installations/new?state=${encodeURIComponent(state)}` };
    }
    throw invalid('This connection type has no authorisation flow');
  });

  app.get('/connections/oauth/jira/callback', { schema: { querystring: z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional() }) } }, async (req, reply) => {
    const sess = verifySession(auth.secret, req.query.state);
    const [, connId, userId] = sess?.uid.split(':') ?? [];
    if (!sess || !connId) return reply.type('text/html').code(400).send(popupDone(false, 'This authorisation link has expired. Start again.'));
    if (req.query.error || !req.query.code) return reply.type('text/html').send(popupDone(false, `Atlassian reported: ${req.query.error ?? 'no code'}`));
    try {
      const c = await conns.get(connId);
      const cfg = c.config as Record<string, string>;
      const tok = await jiraExchangeCode({ clientId: cfg.clientId, clientSecret: (await s.secrets.get('connection', c.id, 'client_secret')) ?? '', code: req.query.code, redirectUri: `${ctx.cfg.publicUrl}/api/v1/connections/oauth/jira/callback` });
      const sites = await jiraAccessibleSites(tok.accessToken);
      if (!sites.length) throw new Error('No Jira site is accessible with this account');
      await conns.completeJiraOAuth(c.id, tok, sites[0], userId);
      return reply.type('text/html').send(popupDone(true, `Connected to ${sites[0].name}. You can close this window.`, c.id));
    } catch (e) { return reply.type('text/html').send(popupDone(false, (e as Error).message)); }
  });

  app.get('/connections/oauth/github/callback', { schema: { querystring: z.object({ installation_id: z.string().optional(), state: z.string().optional(), setup_action: z.string().optional() }) } }, async (req, reply) => {
    const sess = verifySession(auth.secret, req.query.state);
    const [, connId] = sess?.uid.split(':') ?? [];
    if (!sess || !connId || !req.query.installation_id) return reply.type('text/html').code(400).send(popupDone(false, 'Installation was not completed or the link expired.'));
    const c = await conns.get(connId);
    await db.update(t.connections).set({ config: { ...c.config, installationId: req.query.installation_id }, updatedAt: new Date() }).where(eq(t.connections.id, c.id));
    await conns.test(c.id).catch(() => undefined);
    return reply.type('text/html').send(popupDone(true, 'GitHub App installed. You can close this window.', c.id));
  });
}

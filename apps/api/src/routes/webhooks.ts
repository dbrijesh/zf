import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { desc, eq, and } from 'drizzle-orm';
import crypto from 'node:crypto';
import { tables as t } from '@zerovity/db';
import { parseWebhook, verifyWebhookSignature } from '@zerovity/forge-github';
import { parseJiraWebhook } from '@zerovity/tracker';
import { ulid, randomToken, notFound, errMessage, unauthorized, invalid } from '@zerovity/core';
import { checkDefinitionPr, syncDefinitionFromGit } from '@zerovity/orchestrator';
import { hashToken } from '../auth';
import { user, factoryFor, type AppCtx } from '../context';
import { IdP, Any, Ok } from '../schemas';

declare module 'fastify' { interface FastifyRequest { rawBody?: Buffer } }

/** Inbound webhooks. Public routes (no session): they authenticate by signature or secret. */
export async function webhookPublicRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { s, intake } = ctx;
  const db = s.db;
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try { done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {}); } catch (e) { done(e as Error); }
  });
  const log = async (webhookId: string | null, provider: string, event: string | null, status: string, detail: string, body?: Buffer) =>
    db.insert(t.webhookDeliveries).values({ id: ulid(), webhookId, provider, event, status, detail: detail.slice(0, 500), payloadHash: body ? crypto.createHash('sha256').update(body).digest('hex') : null }).catch(() => undefined);

  app.post('/webhooks/github', async (req, reply) => {
    const event = String(req.headers['x-github-event'] ?? '');
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    const raw = req.rawBody ?? Buffer.from('');
    const forgeConns = await db.select().from(t.connections).where(eq(t.connections.type, 'forge'));
    let matched: (typeof forgeConns)[number] | undefined;
    for (const c of forgeConns) { const secret = await s.secrets.get('connection', c.id, 'webhook_secret'); if (secret && verifyWebhookSignature(secret, raw, sig)) { matched = c; break; } }
    if (!matched) { await log(null, 'github', event, 'rejected', 'bad or missing signature', raw); throw unauthorized('Invalid webhook signature'); }
    if (event === 'ping') return reply.send({ ok: true, pong: true });
    const payload = req.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      const results: unknown[] = [];
      // Git-backed definition repositories: validate PRs, sync on push
      const slug = String(payload.repository?.full_name ?? '').toLowerCase();
      const defFactories = (await db.select().from(t.factories)).filter((f) => f.definitionSource === 'git' && f.definitionRepo && `${f.definitionRepo.owner}/${f.definitionRepo.name}`.toLowerCase() === slug);
      for (const f of defFactories) {
        const forge = await ctx.forges.forRepo(f.id, { forge: 'github', owner: f.definitionRepo!.owner, name: f.definitionRepo!.name });
        if (!forge) continue;
        if (event === 'pull_request' && ['opened', 'synchronize', 'reopened'].includes(payload.action)) results.push(await checkDefinitionPr(s, forge, { owner: f.definitionRepo!.owner, name: f.definitionRepo!.name, headSha: payload.pull_request.head.sha, path: f.definitionRepo!.path }));
        if (event === 'push' && payload.ref === `refs/heads/${f.definitionRepo!.branch}`) results.push(await syncDefinitionFromGit(s, ctx.forges, f.id));
      }
      const ev = parseWebhook(event, payload);
      if (ev.type !== 'config_pr') results.push(...(await intake.onForgeEvent(ev, { orgId: matched.orgId })));
      await log(null, 'github', event, 'processed', JSON.stringify(results).slice(0, 400), raw);
      return reply.code(202).send({ ok: true, results });
    } catch (e) {
      await log(null, 'github', event, 'error', errMessage(e), raw);
      req.log.error({ err: e }, 'github webhook failed');
      return reply.code(202).send({ ok: false, error: errMessage(e) });
    }
  });

  app.post('/webhooks/jira/:token', async (req, reply) => {
    const raw = req.rawBody ?? Buffer.from('');
    const tracker = (await db.select().from(t.connections).where(eq(t.connections.type, 'tracker'))).find((c) => {
      const tok = (c.config as { webhookToken?: string }).webhookToken ?? '';
      return tok.length === (req.params as { token: string }).token.length && tok.length > 0 && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from((req.params as { token: string }).token));
    });
    if (!tracker) { await log(null, 'jira', null, 'rejected', 'unknown token', raw); throw unauthorized('Unknown webhook token'); }
    const site = (tracker.config as { siteUrl?: string; baseUrl?: string }).siteUrl ?? (tracker.config as { baseUrl?: string }).baseUrl ?? '';
    const ev = parseJiraWebhook(req.body as Record<string, unknown>, site);
    try {
      const results = await intake.onTrackerEvent(ev);
      await log(null, 'jira', String((req.body as { webhookEvent?: string }).webhookEvent ?? ''), 'processed', JSON.stringify(results).slice(0, 400), raw);
      return reply.code(202).send({ ok: true, results });
    } catch (e) { await log(null, 'jira', null, 'error', errMessage(e), raw); return reply.code(202).send({ ok: false, error: errMessage(e) }); }
  });

  app.post('/webhooks/inbound/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [h] = await db.select().from(t.webhooks).where(eq(t.webhooks.id, id));
    const presented = (req.headers['x-zerovity-secret'] as string | undefined) ?? req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const ok = !!h && h.enabled && presented.length > 0 && crypto.timingSafeEqual(Buffer.from(hashToken(presented)), Buffer.from(h.secretHash));
    if (!ok || !h?.factoryId) { await log(id, 'webhook', null, 'rejected', 'bad secret', req.rawBody); throw unauthorized('Invalid webhook secret'); }
    const body = req.body as { title?: string; body?: string; ref?: string };
    try {
      const r = await intake.onWebhook(h.factoryId, h.name, body);
      await log(id, 'webhook', null, 'processed', r.handled, req.rawBody);
      return reply.code(202).send(r);
    } catch (e) { await log(id, 'webhook', null, 'error', errMessage(e), req.rawBody); throw e; }
  });
}

/** Management of inbound webhooks (authenticated). */
export async function webhookAdminRoutes(app0: FastifyInstance, ctx: AppCtx) {
  const app = app0.withTypeProvider<ZodTypeProvider>();
  const { s } = ctx;
  const db = s.db;
  const urlFor = (id: string) => `${ctx.cfg.publicUrl.replace(/\/$/, '')}/api/v1/webhooks/inbound/${id}`;
  app.get('/webhooks', { schema: { querystring: z.object({ factoryId: z.string().optional() }), response: { 200: Any } } }, async (req) => {
    const u = user(req);
    const rows = await db.select().from(t.webhooks).where(eq(t.webhooks.orgId, u.orgId)).orderBy(desc(t.webhooks.createdAt));
    const gh = (await db.select().from(t.connections).where(eq(t.connections.orgId, u.orgId))).filter((c) => c.type === 'forge' || c.type === 'tracker');
    return {
      inbound: rows.filter((r) => !req.query.factoryId || r.factoryId === req.query.factoryId).map((r) => ({ id: r.id, name: r.name, factoryId: r.factoryId, url: urlFor(r.id), secretLast4: r.secretLast4, enabled: r.enabled, createdAt: r.createdAt })),
      github: { url: `${ctx.cfg.publicUrl.replace(/\/$/, '')}/api/v1/webhooks/github`, events: ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'check_suite', 'push'] },
      jira: gh.filter((c) => c.type === 'tracker').map((c) => ({ connection: c.displayName, url: `${ctx.cfg.publicUrl.replace(/\/$/, '')}/api/v1/webhooks/jira/${(c.config as { webhookToken?: string }).webhookToken ?? ''}`, events: ['jira:issue_created', 'jira:issue_updated', 'comment_created'] })),
    };
  });
  app.post('/webhooks', { schema: { body: z.object({ name: z.string().regex(/^[a-z][a-z0-9-]*$/), factoryId: z.string() }), response: { 200: Any } } }, async (req) => {
    const { f, u } = await factoryFor(ctx, req, req.body.factoryId, 'factory_owner');
    const secret = `zfw_${randomToken(20)}`;
    const id = ulid();
    await db.insert(t.webhooks).values({ id, orgId: f.orgId, factoryId: f.id, name: req.body.name, secretHash: hashToken(secret), secretLast4: secret.slice(-4) });
    await s.orch.audit(f.id, u.id, 'webhook.created', req.body.name, { id });
    return { id, url: urlFor(id), secret, note: 'Copy the secret now; it is not shown again. Send it as the x-zerovity-secret header.' };
  });
  app.post('/webhooks/:id/rotate', { schema: { params: IdP, response: { 200: Any } } }, async (req) => {
    const u = user(req);
    const [h] = await db.select().from(t.webhooks).where(and(eq(t.webhooks.id, req.params.id), eq(t.webhooks.orgId, u.orgId)));
    if (!h) throw notFound('Webhook');
    await factoryFor(ctx, req, h.factoryId ?? '', 'factory_owner');
    const secret = `zfw_${randomToken(20)}`;
    await db.update(t.webhooks).set({ secretHash: hashToken(secret), secretLast4: secret.slice(-4), updatedAt: new Date() }).where(eq(t.webhooks.id, h.id));
    await s.orch.audit(h.factoryId!, u.id, 'webhook.rotated', h.name, { id: h.id });
    return { id: h.id, url: urlFor(h.id), secret };
  });
  app.delete('/webhooks/:id', { schema: { params: IdP, response: { 200: Ok } } }, async (req) => {
    const u = user(req);
    const [h] = await db.select().from(t.webhooks).where(and(eq(t.webhooks.id, req.params.id), eq(t.webhooks.orgId, u.orgId)));
    if (!h) throw notFound('Webhook');
    await factoryFor(ctx, req, h.factoryId ?? '', 'factory_owner');
    await db.delete(t.webhooks).where(eq(t.webhooks.id, h.id));
    return { ok: true };
  });
  app.get('/webhooks/deliveries', { schema: { querystring: z.object({ webhookId: z.string().optional(), provider: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), response: { 200: Any } } }, async (req) => {
    user(req);
    const rows = await db.select().from(t.webhookDeliveries).orderBy(desc(t.webhookDeliveries.createdAt)).limit(req.query.limit);
    return rows.filter((r) => (!req.query.webhookId || r.webhookId === req.query.webhookId) && (!req.query.provider || r.provider === req.query.provider));
  });
  void invalid;
}

import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import '@fastify/cookie';
import '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import fstatic from '@fastify/static';
import swagger from '@fastify/swagger';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { ZfError, errMessage } from '@zerovity/core';
import { ConnectionService, IntakeService, DbForgeResolver, TrackerResolver, SourceNotifier, type Services } from '@zerovity/orchestrator';
import { handleMcpRequest } from '@zerovity/mcp';
import { Auth } from './auth';
import type { ApiConfig, AppCtx } from './context';
import { coreRoutes } from './routes/core';
import { studioRoutes } from './routes/studio';
import { opsRoutes } from './routes/ops';
import { connectionRoutes } from './routes/connections';
import { webhookPublicRoutes, webhookAdminRoutes } from './routes/webhooks';
import { sseRoutes } from './routes/sse';
import { authRoutes } from './routes/auth';

export interface BuildOptions { services: Services; cfg: Partial<ApiConfig> & { publicUrl?: string }; sessionSecret?: Buffer; logger?: boolean }

function setCache(res: unknown, v: string) { const r = res as { header?: (k: string, v: string) => unknown; setHeader?: (k: string, v: string) => unknown }; if (r.setHeader) r.setHeader('cache-control', v); else r.header?.('cache-control', v); }

export function makeConfig(c: Partial<ApiConfig> = {}): ApiConfig {
  const env = process.env;
  const oidc = env.OIDC_ISSUER && env.OIDC_CLIENT_ID ? { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET ?? '', scopes: env.OIDC_SCOPES ?? 'openid profile email', groupsClaim: env.OIDC_GROUPS_CLAIM ?? 'groups', adminGroups: (env.OIDC_ADMIN_GROUPS ?? '').split(',').filter(Boolean), approverGroups: (env.OIDC_APPROVER_GROUPS ?? '').split(',').filter(Boolean), ownerGroups: (env.OIDC_OWNER_GROUPS ?? '').split(',').filter(Boolean) } : undefined;
  return { devLogin: env.ZF_DEV_LOGIN ? env.ZF_DEV_LOGIN === '1' : !oidc && env.NODE_ENV !== 'production', publicUrl: env.ZF_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`, version: '0.1.0', oidc, ...c };
}

/** Assemble the Fastify app (spec 3: apps/api). Everything under /api/v1 except /health, /auth, /webhooks and /schemas needs a session or PAT. */
export async function buildApp(o: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppCtx }> {
  const { services: s } = o;
  const cfg = makeConfig(o.cfg);
  const secret = o.sessionSecret ?? s.sessionSecret;
  const auth = new Auth(s.db, secret, { devLogin: cfg.devLogin, secureCookies: cfg.publicUrl.startsWith('https://'), sessionHours: Number(process.env.ZF_SESSION_HOURS ?? 12) });
  const conns = new ConnectionService(s);
  const forges = new DbForgeResolver({ db: s.db, secrets: s.secrets, conns } as never);
  const trackers = new TrackerResolver(conns, s.db);
  const intake = new IntakeService(s, { forges, trackers });
  // foreman updates go to the GitHub / Jira thread of the item's source
  s.orch.d.notifier = new SourceNotifier(s, forges, trackers, s.log);
  s.orch.d.forges = forges;
  s.hub.subscribe((e) => { if (e.type === 'transition' && e.workItemId) void intake.onPhaseChanged(String(e.workItemId), String(e.to)).catch(() => undefined); });
  const ctx: AppCtx = { s, auth, conns, intake, forges, trackers, cfg };

  const app = Fastify({ logger: o.logger ? { level: process.env.LOG_LEVEL ?? 'info' } : false, bodyLimit: 25 * 1024 * 1024, trustProxy: true });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  if (cfg.cors?.length) await app.register(cors, { origin: cfg.cors, credentials: true });
  await app.register(swagger, { openapi: { info: { title: 'Zerovity Factory API', version: cfg.version, description: 'Versioned REST API. Authenticate with a session cookie or `Authorization: Bearer zfp_...`.' }, components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, security: [{ bearer: [] }] }, transform: jsonSchemaTransform });

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) return reply.code(400).send({ error: 'invalid', message: 'Request validation failed', details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) });
    if (isResponseSerializationError(err)) { req.log.error({ err }, 'response failed validation'); return reply.code(500).send({ error: 'bad_response', message: 'The server produced an invalid response' }); }
    if (err instanceof ZfError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    const e = err as { statusCode?: number; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'request', message: e.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: process.env.NODE_ENV === 'production' ? 'Internal error' : errMessage(err) });
  });

  // authentication for everything under /api/v1 except the public prefixes
  const PUBLIC = [/^\/api\/v1\/health/, /^\/api\/v1\/ready/, /^\/api\/v1\/auth\//, /^\/api\/v1\/webhooks\/(github|jira|inbound)/, /^\/api\/v1\/schemas\//, /^\/api\/v1\/openapi\.json/, /^\/api\/v1\/connections\/oauth\//];
  app.decorateRequest('user', undefined);
  app.addHook('preHandler', async (req) => {
    const url = req.url.split('?')[0];
    const u = await auth.fromRequest(req);
    if (u) (req as unknown as { user: typeof u }).user = u;
    if (!url.startsWith('/api/v1') && !url.startsWith('/mcp')) return;
    if (PUBLIC.some((r) => r.test(url))) return;
    if (!u) throw new ZfError('unauthorized', 'Authentication required', 401);
  });
  app.addHook('onSend', async (_req, reply) => { reply.header('x-content-type-options', 'nosniff'); reply.header('referrer-policy', 'same-origin'); });

  app.get('/api/v1/health', async () => ({ ok: true, version: cfg.version, time: new Date().toISOString() }));
  app.get('/api/v1/ready', async (_req, reply) => {
    try { await s.db.execute(sql`select 1`); return { ok: true, db: s.handle.kind, queue: await s.queue.stats('run') }; } catch (e) { return reply.code(503).send({ ok: false, error: errMessage(e) }); }
  });
  app.get('/api/v1/openapi.json', async () => app.swagger());

  await app.register(async (api) => { await authRoutes(api, ctx); }, { prefix: '/api/v1' });
  await app.register(async (api) => { await webhookPublicRoutes(api, ctx); }, { prefix: '/api/v1' });
  await app.register(async (api) => {
    await coreRoutes(api, ctx);
    await studioRoutes(api, ctx);
    await opsRoutes(api, ctx);
    await connectionRoutes(api, ctx);
    await webhookAdminRoutes(api, ctx);
    await sseRoutes(api, ctx);
  }, { prefix: '/api/v1' });

  // Factory MCP server, streamable HTTP, personal access token or session auth
  app.all('/mcp', async (req, reply) => {
    const u = (req as unknown as { user?: Awaited<ReturnType<Auth['load']>> }).user;
    if (!u) return reply.code(401).header('www-authenticate', 'Bearer realm="zerovity"').send({ jsonrpc: '2.0', error: { code: -32001, message: 'Authenticate with a personal access token' }, id: null });
    if (req.method !== 'POST') return reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST' }, id: null });
    reply.hijack();
    await handleMcpRequest({ s, publicUrl: cfg.publicUrl }, { id: u.id, orgId: u.orgId, name: u.name, groups: u.groups, roleFor: (fid) => auth.roleFor(u, fid) }, req.raw, reply.raw, req.body);
  });

  // the built web app (production)
  const dist = cfg.webDist ?? path.resolve(s.repoRoot, 'apps/web/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    await app.register(fstatic, { root: dist, wildcard: false, cacheControl: false, setHeaders: (res, p) => { setCache(res as unknown, /[\\/]assets[\\/]/.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache'); } });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) return reply.code(404).send({ error: 'not_found', message: 'No such endpoint' });
      return reply.type('text/html').header('cache-control', 'no-cache').send(fs.createReadStream(path.join(dist, 'index.html')));
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found', message: req.url.startsWith('/api/') ? 'No such endpoint' : 'The web app is not built. Run `npm run build` or use `npm run dev`.' }));
  }
  await app.ready();
  return { app, ctx };
}

declare module 'fastify' { interface FastifyRequest { user?: import('./auth').AuthedUser } }

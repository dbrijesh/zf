import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import * as oc from 'openid-client';
import { tables as t } from '@zerovity/db';
import { ulid, unauthorized, invalid, forbidden, ZfError, type Role, ROLE_RANK } from '@zerovity/core';
import { ensureOrg, ensureUser } from '@zerovity/orchestrator';
import { signSession, verifySession, REAUTH_WINDOW_MS, type AuthedUser } from '../auth';
import type { AppCtx } from '../context';
import { Ok, Any } from '../schemas';

/** Only same-site paths: //evil.example and /\\evil.example are protocol-relative and would send the user elsewhere. */
export const safeNext = (n: unknown): string => (typeof n === 'string' && /^\/(?![\/\\])/.test(n) && !/[\r\n]/.test(n) ? n : '/');

/** Fixed-window limiter per client address (in memory: one API instance; put a proxy limit in front for a fleet). */
export function makeLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): boolean => {
    const t = now(); const h = hits.get(key);
    if (!h || h.reset <= t) { hits.set(key, { n: 1, reset: t + windowMs }); if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); return true; }
    h.n++; return h.n <= max;
  };
}

/** Public auth routes: dev login, OIDC (Entra ID, Okta, Keycloak), logout, re-authentication for e-signatures. */
export async function authRoutes(app0: FastifyInstance, ctx: AppCtx) {
  const app = app0.withTypeProvider<ZodTypeProvider>();
  const { s, auth, cfg } = ctx;
  const db = s.db;
  let oidcConfig: Promise<oc.Configuration> | undefined;
  const getOidc = () => (oidcConfig ??= oc.discovery(new URL(cfg.oidc!.issuer), cfg.oidc!.clientId, cfg.oidc!.clientSecret));
  const redirectUri = `${cfg.publicUrl.replace(/\/$/, '')}/api/v1/auth/oidc/callback`;

  app.get('/auth/config', { schema: { response: { 200: z.object({ devLogin: z.boolean(), oidc: z.boolean(), version: z.string() }) } } }, async () => ({ devLogin: cfg.devLogin, oidc: !!cfg.oidc, version: cfg.version }));

  const devLimit = makeLimiter(20, 60_000);
  app.post('/auth/dev-login', { schema: { body: z.object({ email: z.string().email(), name: z.string().optional() }), response: { 200: Any } } }, async (req, reply) => {
    if (!devLimit(req.ip)) throw new ZfError('rate_limited', 'Too many sign-in attempts; wait a minute', 429);
    const u = await auth.devLogin(req.body.email, req.body.name);
    auth.startSession(reply, u.id);
    await s.orch.audit(`org:${u.orgId}`, u.id, 'auth.login', u.email, { method: 'dev' }).catch(() => undefined);
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  });

  app.post('/auth/logout', { schema: { response: { 200: Ok } } }, async (_req, reply) => { auth.endSession(reply); return { ok: true }; });
  /** Sign out on every device: older sessions stop working at once. */
  app.post('/auth/logout-all', { schema: { response: { 200: Ok } } }, async (req, reply) => {
    const u = (req as unknown as { user?: AuthedUser }).user;
    if (!u) throw unauthorized();
    await auth.revokeSessions(u.id);
    auth.endSession(reply);
    await s.orch.audit(`org:${u.orgId}`, u.id, 'auth.logout_all', u.email, {}).catch(() => undefined);
    return { ok: true };
  });

  /** Re-authentication before a signing action (21 CFR Part 11 style). Dev: confirm the email. OIDC: redirect with prompt=login. */
  app.post('/auth/reauth', { schema: { body: z.object({ email: z.string().email().optional() }).default({}), response: { 200: Any } } }, async (req, reply) => {
    const u = (req as unknown as { user?: AuthedUser }).user;
    if (!u) throw unauthorized();
    if (cfg.oidc) return { redirect: `/api/v1/auth/oidc/login?reauth=1` };
    if (!cfg.devLogin) throw forbidden('Re-authentication is not configured');
    if (req.body.email?.toLowerCase() !== u.email) throw unauthorized('Email does not match the signed-in user');
    auth.startSession(reply, u.id, Date.now());
    await s.orch.audit(`org:${u.orgId}`, u.id, 'auth.reauth', u.email, { method: 'dev' }).catch(() => undefined);
    return { ok: true, validForSeconds: REAUTH_WINDOW_MS / 1000 };
  });

  if (cfg.oidc) {
    const o = cfg.oidc;
    app.get('/auth/oidc/login', { schema: { querystring: z.object({ reauth: z.string().optional(), next: z.string().optional() }) } }, async (req, reply) => {
      const config = await getOidc();
      const verifier = oc.randomPKCECodeVerifier();
      const state = oc.randomState();
      const params: Record<string, string> = { redirect_uri: redirectUri, scope: o.scopes, code_challenge: await oc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state };
      if (req.query.reauth) { params.prompt = 'login'; params.max_age = '0'; }
      reply.setCookie('zf_oidc', signSession(auth.secret, { uid: JSON.stringify({ v: verifier, s: state, r: !!req.query.reauth, n: req.query.next ?? '/' }), exp: Date.now() + 10 * 60_000 }), { path: '/api/v1/auth', httpOnly: true, sameSite: 'lax', secure: auth.cfg.secureCookies, maxAge: 600 });
      return reply.redirect(oc.buildAuthorizationUrl(config, params).toString());
    });

    app.get('/auth/oidc/callback', async (req, reply) => {
      const sess = verifySession(auth.secret, (req.cookies as Record<string, string>).zf_oidc);
      if (!sess) throw unauthorized('Login session expired; start again');
      const { v, s: state, r, n } = JSON.parse(sess.uid) as { v: string; s: string; r: boolean; n: string };
      const config = await getOidc();
      const current = new URL(req.url, cfg.publicUrl);
      const tokens = await oc.authorizationCodeGrant(config, current, { pkceCodeVerifier: v, expectedState: state });
      const claims = tokens.claims();
      if (!claims) throw unauthorized('The identity provider returned no ID token');
      const email = String((claims.email as string | undefined) ?? (claims.preferred_username as string | undefined) ?? '').toLowerCase();
      if (!email) throw invalid('The identity provider did not release an email address');
      // an unverified email must never decide who someone is (Entra ID does not verify the email claim: bind by sub and restrict domains)
      if (claims.email_verified === false) throw unauthorized('The identity provider has not verified this email address');
      if (o.allowedDomains.length && !o.allowedDomains.includes(email.split('@')[1] ?? '')) throw forbidden('This email domain is not allowed to sign in');
      const groups = ((claims[o.groupsClaim] as string[] | string | undefined) ?? []);
      const gl = Array.isArray(groups) ? groups : [groups];
      const org = await ensureOrg(db);
      const [first] = await db.select({ id: t.users.id }).from(t.users).limit(1);
      const [known] = await db.select().from(t.users).where(and(eq(t.users.orgId, org.id), eq(t.users.email, email)));
      // once an account is linked to an IdP subject it cannot be taken over by another identity that claims the same email
      if (known?.externalId && known.externalId !== String(claims.sub)) throw unauthorized('This email is already linked to a different identity');
      const firstRole: Role = o.bootstrapAdmin && o.bootstrapAdmin !== email ? 'member' : 'org_admin';
      const u = await ensureUser(db, org.id, { email, name: String(claims.name ?? email.split('@')[0]), groups: gl, externalId: String(claims.sub), role: first ? 'member' : firstRole });
      // IdP groups raise (never silently lower) the org role
      const mapped: Role | undefined = gl.some((g) => o.adminGroups.includes(g)) ? 'org_admin' : gl.some((g) => o.ownerGroups.includes(g)) ? 'factory_owner' : gl.some((g) => o.approverGroups.includes(g)) ? 'approver' : undefined;
      if (mapped) {
        const [m] = await db.select().from(t.memberships).where(and(eq(t.memberships.userId, u.id), eq(t.memberships.orgId, org.id)));
        if (!m) await db.insert(t.memberships).values({ id: ulid(), userId: u.id, orgId: org.id, factoryId: null, role: mapped });
        else if (!m.factoryId && ROLE_RANK[m.role as Role] < ROLE_RANK[mapped]) await db.update(t.memberships).set({ role: mapped }).where(eq(t.memberships.id, m.id));
      }
      auth.startSession(reply, u.id, r ? Date.now() : undefined);
      reply.clearCookie('zf_oidc', { path: '/api/v1/auth' });
      await s.orch.audit(`org:${org.id}`, u.id, r ? 'auth.reauth' : 'auth.login', email, { method: 'oidc', groups: gl }).catch(() => undefined);
      return reply.redirect(safeNext(n));
    });
  }
}

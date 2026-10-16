import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import * as oc from 'openid-client';
import { tables as t } from '@zerovity/db';
import { ulid, unauthorized, invalid, forbidden, type Role, ROLE_RANK } from '@zerovity/core';
import { ensureOrg, ensureUser } from '@zerovity/orchestrator';
import { signSession, verifySession, REAUTH_WINDOW_MS, type AuthedUser } from '../auth';
import type { AppCtx } from '../context';
import { Ok, Any } from '../schemas';

/** Public auth routes: dev login, OIDC (Entra ID, Okta, Keycloak), logout, re-authentication for e-signatures. */
export async function authRoutes(app0: FastifyInstance, ctx: AppCtx) {
  const app = app0.withTypeProvider<ZodTypeProvider>();
  const { s, auth, cfg } = ctx;
  const db = s.db;
  let oidcConfig: Promise<oc.Configuration> | undefined;
  const getOidc = () => (oidcConfig ??= oc.discovery(new URL(cfg.oidc!.issuer), cfg.oidc!.clientId, cfg.oidc!.clientSecret));
  const redirectUri = `${cfg.publicUrl.replace(/\/$/, '')}/api/v1/auth/oidc/callback`;

  app.get('/auth/config', { schema: { response: { 200: z.object({ devLogin: z.boolean(), oidc: z.boolean(), version: z.string() }) } } }, async () => ({ devLogin: cfg.devLogin, oidc: !!cfg.oidc, version: cfg.version }));

  app.post('/auth/dev-login', { schema: { body: z.object({ email: z.string().email(), name: z.string().optional() }), response: { 200: Any } } }, async (req, reply) => {
    const u = await auth.devLogin(req.body.email, req.body.name);
    auth.startSession(reply, u.id);
    await s.orch.audit(`org:${u.orgId}`, u.id, 'auth.login', u.email, { method: 'dev' }).catch(() => undefined);
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  });

  app.post('/auth/logout', { schema: { response: { 200: Ok } } }, async (_req, reply) => { auth.endSession(reply); return { ok: true }; });

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
      const groups = ((claims[o.groupsClaim] as string[] | string | undefined) ?? []);
      const gl = Array.isArray(groups) ? groups : [groups];
      const org = await ensureOrg(db);
      const [first] = await db.select({ id: t.users.id }).from(t.users).limit(1);
      const u = await ensureUser(db, org.id, { email, name: String(claims.name ?? email.split('@')[0]), groups: gl, externalId: String(claims.sub), role: first ? 'member' : 'org_admin' });
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
      return reply.redirect(n.startsWith('/') ? n : '/');
    });
  }
}

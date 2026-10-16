import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ulid, unauthorized, forbidden, roleAtLeast, ROLE_RANK, randomToken, type Role } from '@zerovity/core';
import { tables as t, type Db } from '@zerovity/db';
import { ensureOrg, ensureUser } from '@zerovity/orchestrator';

export interface AuthedUser {
  id: string; orgId: string; email: string; name: string; groups: string[];
  /** highest org-wide role */
  role: Role;
  memberships: Array<{ factoryId: string | null; role: Role }>;
  via: 'session' | 'pat';
  reauthAt?: number;
}

export interface SessionPayload { uid: string; exp: number; reauthAt?: number }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signSession(secret: Buffer, p: SessionPayload): string {
  const body = b64(JSON.stringify(p));
  return `${body}.${b64(crypto.createHmac('sha256', secret).update(body).digest())}`;
}
export function verifySession(secret: Buffer, token: string | undefined): SessionPayload | undefined {
  if (!token) return undefined;
  const [body, sig] = token.split('.');
  if (!body || !sig) return undefined;
  const expect = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return undefined;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    return p.exp > Date.now() ? p : undefined;
  } catch { return undefined; }
}

export const hashToken = (tok: string) => crypto.createHash('sha256').update(tok).digest('hex');
export const COOKIE = 'zf_session';
export const REAUTH_WINDOW_MS = 5 * 60_000;

export class Auth {
  constructor(private db: Db, readonly secret: Buffer, readonly cfg: { devLogin: boolean; secureCookies: boolean; sessionHours: number }) {}

  async load(uid: string, via: 'session' | 'pat', reauthAt?: number): Promise<AuthedUser | undefined> {
    const [u] = await this.db.select().from(t.users).where(eq(t.users.id, uid));
    if (!u) return undefined;
    const ms = await this.db.select().from(t.memberships).where(eq(t.memberships.userId, uid));
    const role = ms.filter((m) => !m.factoryId).map((m) => m.role as Role).sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] ?? 'viewer';
    return { id: u.id, orgId: u.orgId, email: u.email, name: u.name, groups: u.groups, role, memberships: ms.map((m) => ({ factoryId: m.factoryId, role: m.role as Role })), via, reauthAt };
  }

  async fromRequest(req: FastifyRequest): Promise<AuthedUser | undefined> {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      const tok = h.slice(7).trim();
      if (tok.startsWith('zfp_')) {
        const [row] = await this.db.select().from(t.personalAccessTokens).where(eq(t.personalAccessTokens.tokenHash, hashToken(tok)));
        if (!row || (row.expiresAt && row.expiresAt < new Date())) return undefined;
        await this.db.update(t.personalAccessTokens).set({ lastUsedAt: new Date() }).where(eq(t.personalAccessTokens.id, row.id));
        return this.load(row.userId, 'pat');
      }
    }
    const sess = verifySession(this.secret, (req.cookies as Record<string, string> | undefined)?.[COOKIE]);
    return sess ? this.load(sess.uid, 'session', sess.reauthAt) : undefined;
  }

  startSession(reply: FastifyReply, uid: string, reauthAt?: number) {
    const exp = Date.now() + this.cfg.sessionHours * 3_600_000;
    reply.setCookie(COOKIE, signSession(this.secret, { uid, exp, reauthAt }), { path: '/', httpOnly: true, sameSite: 'lax', secure: this.cfg.secureCookies, maxAge: this.cfg.sessionHours * 3600 });
  }
  endSession(reply: FastifyReply) { reply.clearCookie(COOKIE, { path: '/' }); }

  /** role in a factory: the higher of the org-wide role and any factory-specific membership */
  roleFor(u: AuthedUser, factoryId?: string | null): Role {
    let best = ROLE_RANK[u.role];
    for (const m of u.memberships) if (m.factoryId && m.factoryId === factoryId) best = Math.max(best, ROLE_RANK[m.role]);
    return (Object.entries(ROLE_RANK).find(([, v]) => v === best)?.[0] ?? 'viewer') as Role;
  }
  need(u: AuthedUser, role: Role, factoryId?: string | null) {
    if (!roleAtLeast(this.roleFor(u, factoryId), role)) throw forbidden(`Requires the ${role} role`);
  }

  async createPat(userId: string, name: string, days?: number): Promise<{ token: string; id: string }> {
    const token = `zfp_${randomToken(24)}`;
    const id = ulid();
    await this.db.insert(t.personalAccessTokens).values({ id, userId, name, tokenHash: hashToken(token), prefix: token.slice(0, 8), expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null });
    return { token, id };
  }

  /** Dev login: allowed only when explicitly enabled. First user of a fresh install becomes org admin. */
  async devLogin(email: string, name?: string): Promise<AuthedUser> {
    if (!this.cfg.devLogin) throw forbidden('Dev login is disabled');
    const org = await ensureOrg(this.db);
    const [first] = await this.db.select({ id: t.users.id }).from(t.users).limit(1);
    const existing = (await this.db.select().from(t.users).where(and(eq(t.users.orgId, org.id), eq(t.users.email, email.toLowerCase()))))[0];
    const u = existing ?? (await ensureUser(this.db, org.id, { email, name: name ?? email.split('@')[0], role: first ? 'member' : 'org_admin' }));
    const au = await this.load(u.id, 'session');
    if (!au) throw unauthorized();
    return au;
  }
}

export const requireUser = (req: FastifyRequest): AuthedUser => {
  const u = (req as FastifyRequest & { user?: AuthedUser }).user;
  if (!u) throw unauthorized();
  return u;
};

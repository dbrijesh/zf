import type { Services, ConnectionService, IntakeService, DbForgeResolver, TrackerResolver } from '@zerovity/orchestrator';
import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { tables as t } from '@zerovity/db';
import { notFound, forbidden, type Role } from '@zerovity/core';
import { requireUser, type Auth, type AuthedUser } from './auth';

export interface ApiConfig {
  webDist?: string;
  devLogin: boolean;
  publicUrl: string;
  cors?: string[];
  oidc?: { issuer: string; clientId: string; clientSecret: string; scopes: string; groupsClaim: string; adminGroups: string[]; approverGroups: string[]; ownerGroups: string[] };
  /** a Jira/GitHub OAuth app used for popup flows */
  atlassian?: { clientId: string; clientSecret: string };
  githubAppSlug?: string;
  version: string;
}

export interface AppCtx {
  s: Services;
  auth: Auth;
  conns: ConnectionService;
  intake: IntakeService;
  forges: DbForgeResolver;
  trackers: TrackerResolver;
  cfg: ApiConfig;
}

export const user = requireUser;

/** Load a factory the caller may access and check their role in it. */
export async function factoryFor(ctx: AppCtx, req: FastifyRequest, factoryId: string, role: Role = 'viewer') {
  const u = user(req);
  const [f] = await ctx.s.db.select().from(t.factories).where(eq(t.factories.id, factoryId));
  if (!f || f.orgId !== u.orgId) throw notFound('Factory', factoryId);
  ctx.auth.need(u, role, f.id);
  return { f, u };
}

/** Load a work item the caller may access (through its factory). */
export async function itemFor(ctx: AppCtx, req: FastifyRequest, id: string, role: Role = 'viewer') {
  const [w] = await ctx.s.db.select().from(t.workItems).where(eq(t.workItems.id, id));
  if (!w) throw notFound('Work item', id);
  const x = await factoryFor(ctx, req, w.factoryId, role);
  return { w, ...x };
}

export async function runFor(ctx: AppCtx, req: FastifyRequest, id: string, role: Role = 'viewer') {
  const [r] = await ctx.s.db.select().from(t.runs).where(eq(t.runs.id, id));
  if (!r) throw notFound('Run', id);
  const x = await factoryFor(ctx, req, r.factoryId, role);
  return { r, ...x };
}

export type { AuthedUser };
export { forbidden };

import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { eq, and } from 'drizzle-orm';
import { ulid, createLogger, type HarnessType, type Logger, type Role } from '@zerovity/core';
import { createDb, seedPrices, JobQueue, artifactStoreFromEnv, SecretBox, loadMasterKey, DbSecrets, tables as t, type Db, type DbHandle, type ArtifactStore, type ExternalSecretsProvider } from '@zerovity/db';
import { loadDir, type Files } from '@zerovity/definition';
import { judgeFromEnv, type Judge } from '@zerovity/scoring';
import type { ForgeResolver } from '@zerovity/forge-common';
import { Orchestrator } from './service';
import { DefinitionService, DbPackRegistry, installBuiltinPacks, type ActiveDefinition, type ApplyResult } from './definitions';
import { ContextService } from './contexts';
import { advisorFromEnv, type Advisor } from './advisor';
import { EventHub } from './hub';
import { ScoringService, syncScorers } from './scoring-service';
import type { Notifier } from './types';

export interface Services {
  handle: DbHandle; db: Db; queue: JobQueue; artifacts: ArtifactStore; secrets: DbSecrets; box: SecretBox; hub: EventHub; packs: DbPackRegistry; defs: DefinitionService; contexts: ContextService;
  advisor: Advisor; judge: Judge; scoring: ScoringService; orch: Orchestrator; dataDir: string; log: Logger; repoRoot: string; sessionSecret: Buffer;
  close(): Promise<void>;
}

export interface ServiceOptions {
  dataDir?: string; databaseUrl?: string; repoRoot?: string; packDirs?: string[]; forceHarness?: HarnessType; advisor?: Advisor; judge?: Judge; notifier?: Notifier; forges?: ForgeResolver;
  externalSecrets?: ExternalSecretsProvider[]; log?: Logger; masterKey?: Buffer; allowPrivateUrls?: boolean; artifacts?: ArtifactStore; memory?: boolean;
}

/** Find the repository root (folder holding packs/ and examples/) starting from this file. */
export function findRepoRoot(from = process.cwd()): string {
  let d = path.resolve(from);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'packs', 'zerovity-core'))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return path.resolve(from);
}

export async function createServices(o: ServiceOptions = {}): Promise<Services> {
  const dataDir = path.resolve(o.dataDir ?? process.env.ZF_DATA_DIR ?? '.data');
  const repoRoot = o.repoRoot ?? findRepoRoot();
  const log = o.log ?? createLogger();
  const url = o.databaseUrl ?? process.env.DATABASE_URL;
  const handle = await createDb({ url, dataDir: o.memory ? undefined : path.join(dataDir, 'pg') });
  const db = handle.db;
  await seedPrices(db);
  const artifacts = o.artifacts ?? artifactStoreFromEnv(dataDir);
  const masterKey = o.masterKey ?? loadMasterKey({ dataDir });
  const box = new SecretBox(masterKey);
  const sessionSecret = process.env.ZF_SESSION_SECRET ? crypto.createHash('sha256').update(process.env.ZF_SESSION_SECRET).digest() : crypto.createHmac('sha256', masterKey).update('zerovity-session').digest();
  const secrets = new DbSecrets(db, box);
  const hub = new EventHub();
  const queue = new JobQueue(db);
  const packs = new DbPackRegistry(db, artifacts);
  await installBuiltinPacks(packs, o.packDirs ?? [path.join(repoRoot, 'packs')]);
  const contexts = new ContextService(db, artifacts, { allowPrivateUrls: o.allowPrivateUrls ?? process.env.ZF_ALLOW_PRIVATE_URLS === '1' });
  const advisor = o.advisor ?? advisorFromEnv();
  const judge = o.judge ?? judgeFromEnv();
  const scoring = new ScoringService(db, artifacts, judge);
  const forceHarness = o.forceHarness ?? (process.env.ZF_FORCE_HARNESS as HarnessType | undefined);
  const defs = new DefinitionService(db, packs, {
    forceHarness,
    onApplied: async (factoryId: string, a: ActiveDefinition) => {
      const [f] = await db.select().from(t.factories).where(eq(t.factories.id, factoryId));
      await syncScorers(db, factoryId, a.definition);
      await contexts.syncDefinitionItems(f.orgId, factoryId, Object.values(a.definition.context).map((c) => ({ name: c.name, title: c.fm.title ?? c.name, layer: c.fm.layer, kind: c.fm.kind, body: c.body.trim() || c.fm.body || '', tags: c.fm.tags, priority: c.fm.priority, appliesTo: c.fm.appliesTo, meta: { term: c.fm.term, definition: c.fm.definition, status: c.fm.status, decision: c.fm.decision, repo: c.fm.repo, glob: c.fm.glob } })));
      if (a.definition.factory.shortIdPrefix) await db.update(t.factories).set({ shortPrefix: a.definition.factory.shortIdPrefix, alias: a.definition.factory.alias ?? null }).where(eq(t.factories.id, factoryId));
      else await db.update(t.factories).set({ alias: a.definition.factory.alias ?? null }).where(eq(t.factories.id, factoryId));
    },
  });
  const orch = new Orchestrator({ db, queue, artifacts, defs, contexts, advisor, secrets, hub, notifier: o.notifier, forges: o.forges, log, scoring, options: { forceHarness, externalSecrets: o.externalSecrets } });
  return { handle, db, queue, artifacts, secrets, box, hub, packs, defs, contexts, advisor, judge, scoring, orch, dataDir, log, repoRoot, sessionSecret, close: () => handle.close() };
}

/* -------------------------------------------------------------------------- admin helpers (also used by seeds and tests) */

export async function ensureOrg(db: Db, name = 'Default Org', slug = 'default'): Promise<typeof t.orgs.$inferSelect> {
  const [ex] = await db.select().from(t.orgs).where(eq(t.orgs.slug, slug));
  if (ex) return ex;
  const id = ulid();
  await db.insert(t.orgs).values({ id, name, slug });
  return (await db.select().from(t.orgs).where(eq(t.orgs.id, id)))[0];
}

export async function ensureUser(db: Db, orgId: string, u: { email: string; name: string; role?: Role; groups?: string[]; factoryId?: string | null; externalId?: string }): Promise<typeof t.users.$inferSelect> {
  let [row] = await db.select().from(t.users).where(and(eq(t.users.orgId, orgId), eq(t.users.email, u.email.toLowerCase())));
  if (!row) {
    const id = ulid();
    await db.insert(t.users).values({ id, orgId, email: u.email.toLowerCase(), name: u.name, groups: u.groups ?? [], externalId: u.externalId ?? null });
    await db.insert(t.memberships).values({ id: ulid(), userId: id, orgId, factoryId: u.factoryId ?? null, role: u.role ?? 'member' });
    [row] = await db.select().from(t.users).where(eq(t.users.id, id));
  } else if (u.groups || u.externalId) {
    await db.update(t.users).set({ ...(u.groups ? { groups: u.groups } : {}), ...(u.externalId ? { externalId: u.externalId } : {}), updatedAt: new Date() }).where(eq(t.users.id, row.id));
  }
  return row;
}

export async function createFactory(s: Pick<Services, 'db' | 'defs'>, o: { orgId: string; files: Files; by: string; name?: string; message?: string }): Promise<{ factoryId: string; apply: ApplyResult }> {
  const yamlName = /^name:\s*([\w-]+)/m.exec(o.files['zerovity.factory.yaml'] ?? '')?.[1];
  const name = o.name ?? yamlName ?? 'factory';
  const id = ulid();
  await s.db.insert(t.factories).values({ id, orgId: o.orgId, name, alias: /^alias:\s*([\w-]+)/m.exec(o.files['zerovity.factory.yaml'] ?? '')?.[1] ?? null, shortPrefix: /^shortIdPrefix:\s*([A-Z]+)/m.exec(o.files['zerovity.factory.yaml'] ?? '')?.[1] ?? 'ZF' });
  const apply = await s.defs.apply(id, o.files, { message: o.message ?? 'Initial definition', by: o.by });
  return { factoryId: id, apply };
}

export function loadExample(repoRoot: string, name: string): Files {
  return loadDir(path.join(repoRoot, 'examples', name));
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

export interface DbOptions {
  /** postgres://... for a real server. */
  url?: string;
  /** directory for embedded PGlite data; omit for in-memory (tests). */
  dataDir?: string;
}

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/** Statements that make audit_log append-only for every role (spec 13/14); idempotent. */
const AUDIT_GUARD = [
  `CREATE OR REPLACE FUNCTION zf_audit_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END; $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS zf_audit_no_update ON audit_log`,
  `CREATE TRIGGER zf_audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION zf_audit_immutable()`,
];

export async function createDb(opts: DbOptions = {}): Promise<DbHandle> {
  const url = opts.url ?? process.env.DATABASE_URL;
  let handle: DbHandle;
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { default: pg } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzle(pool, { schema }) as unknown as Db;
    await migrate(db as never, { migrationsFolder: MIGRATIONS });
    handle = { db, kind: 'postgres', close: () => pool.end() };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const dir = opts.dataDir ?? process.env.ZF_DATA_DIR_DB;
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const client = new PGlite(dir);
    await client.waitReady;
    const db = drizzle(client, { schema }) as unknown as Db;
    await migrate(db as never, { migrationsFolder: MIGRATIONS });
    handle = { db, kind: 'pglite', close: () => client.close() };
  }
  for (const stmt of AUDIT_GUARD) await handle.db.execute(sql.raw(stmt));
  return handle;
}

/** Normalise the result of db.execute across node-postgres and PGlite. */
export const rowsOf = <T = Record<string, unknown>>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));

export { schema };

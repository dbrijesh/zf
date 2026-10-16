import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { ulid, errMessage } from '@zerovity/core';
import { buildEntry, verifyChain, type AuditEntry, type AuditInput, type VerifyResult } from '@zerovity/audit';
import { redactValue } from '@zerovity/core';
import type { Db, Tx } from './client';
import * as s from './schema';

type Q = Db | Tx;

/** Append one entry to a hash chain. A transaction-scoped advisory lock keeps the chain linear under concurrency. */
export async function appendAudit(db: Db, input: AuditInput): Promise<AuditEntry> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'audit:' + input.chain}))`);
    const [prev] = await tx.select().from(s.auditLog).where(eq(s.auditLog.chain, input.chain)).orderBy(desc(s.auditLog.seq)).limit(1);
    const entry = buildEntry(prev ? { seq: prev.seq, hash: prev.hash } : undefined, { ...input, payload: redactValue(input.payload ?? null) }, ulid());
    await tx.insert(s.auditLog).values({ id: entry.id, chain: entry.chain, seq: entry.seq, factoryId: entry.factoryId, actor: entry.actor, action: entry.action, subject: entry.subject, payload: entry.payload, payloadHash: entry.payloadHash, prevHash: entry.prevHash, hash: entry.hash, ts: entry.ts });
    return entry;
  });
}

export async function readChain(db: Q, chain: string, opts: { from?: number; limit?: number } = {}): Promise<AuditEntry[]> {
  const rows = await db.select().from(s.auditLog).where(and(eq(s.auditLog.chain, chain), sql`${s.auditLog.seq} >= ${opts.from ?? 1}`)).orderBy(asc(s.auditLog.seq)).limit(opts.limit ?? 100000);
  return rows.map((r) => ({ id: r.id, seq: r.seq, chain: r.chain, factoryId: r.factoryId, actor: r.actor, action: r.action, subject: r.subject, payload: r.payload, payloadHash: r.payloadHash, prevHash: r.prevHash, hash: r.hash, ts: r.ts }));
}

export async function verifyAudit(db: Q, chain: string): Promise<VerifyResult> {
  return verifyChain(await readChain(db, chain));
}

/** Next human short id for a factory (ZF-214), atomic. */
export async function nextShortId(db: Db, factoryId: string): Promise<{ shortId: string; seq: number }> {
  const [row] = await db.update(s.factories).set({ nextSeq: sql`${s.factories.nextSeq} + 1` }).where(eq(s.factories.id, factoryId)).returning({ n: s.factories.nextSeq, p: s.factories.shortPrefix });
  if (!row) throw new Error(`factory ${factoryId} not found`);
  const seq = row.n - 1;
  return { shortId: `${row.p}-${seq}`, seq };
}

/** Append run events with a per-run sequence; returns the highest seq written. */
export async function appendRunEvents(db: Db, runId: string, startSeq: number, events: Array<{ kind: string; payload: Record<string, unknown>; ts?: Date }>): Promise<number> {
  if (!events.length) return startSeq - 1;
  const rows = events.map((e, i) => ({ runId, seq: startSeq + i, kind: e.kind, payload: redactValue(e.payload), ts: e.ts ?? new Date() }));
  await db.insert(s.runEvents).values(rows);
  return startSeq + events.length - 1;
}

export async function kvGet<T>(db: Q, key: string): Promise<T | undefined> {
  const [r] = await db.select().from(s.kv).where(eq(s.kv.key, key));
  return r?.value as T | undefined;
}
export async function kvSet(db: Q, key: string, value: unknown): Promise<void> {
  await db.insert(s.kv).values({ key, value }).onConflictDoUpdate({ target: s.kv.key, set: { value, updatedAt: new Date() } });
}

export { errMessage };

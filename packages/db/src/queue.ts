import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { ulid } from '@zerovity/core';
import { rowsOf, type Db } from './client';
import * as s from './schema';

export type Job = typeof s.jobs.$inferSelect;

export interface EnqueueOptions {
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
  /** only one created or active job per (queue, singletonKey) */
  singletonKey?: string;
}

/**
 * Small durable queue on Postgres using FOR UPDATE SKIP LOCKED (same technique pg-boss uses),
 * so the product keeps exactly one stateful dependency. See docs/DECISIONS.md D-004.
 */
export class JobQueue {
  constructor(private db: Db) {}

  async enqueue(queue: string, payload: Record<string, unknown>, o: EnqueueOptions = {}): Promise<string | null> {
    if (o.singletonKey) {
      const [dup] = await this.db.select({ id: s.jobs.id }).from(s.jobs).where(and(eq(s.jobs.queue, queue), eq(s.jobs.singletonKey, o.singletonKey), inArray(s.jobs.state, ['created', 'active']))).limit(1);
      if (dup) return null;
    }
    const id = ulid();
    await this.db.insert(s.jobs).values({ id, queue, payload, priority: o.priority ?? 0, runAfter: o.runAfter ?? new Date(), maxAttempts: o.maxAttempts ?? 1, singletonKey: o.singletonKey ?? null });
    return id;
  }

  /** Claim the next ready job for a worker; the lock lapses after lockMs unless heartbeats extend it. */
  async claim(queue: string, workerId: string, lockMs = 120_000): Promise<Job | undefined> {
    return this.db.transaction(async (tx) => {
      const res = await tx.execute(sql`
        select id from jobs where queue = ${queue} and state = 'created' and run_after <= now()
        order by priority desc, created_at asc for update skip locked limit 1`);
      const row = rowsOf<{ id: string }>(res)[0];
      if (!row) return undefined;
      const [job] = await tx.update(s.jobs).set({ state: 'active', lockedBy: workerId, lockedUntil: new Date(Date.now() + lockMs), attempts: sql`${s.jobs.attempts} + 1`, startedAt: new Date() }).where(eq(s.jobs.id, row.id)).returning();
      return job;
    });
  }

  /** Give a claimed job back without consuming an attempt (used when concurrency limits say wait). */
  async release(id: string, delayMs: number): Promise<void> {
    await this.db.update(s.jobs).set({ state: 'created', lockedBy: null, lockedUntil: null, attempts: sql`greatest(${s.jobs.attempts} - 1, 0)`, runAfter: new Date(Date.now() + delayMs) }).where(eq(s.jobs.id, id));
  }

  async heartbeat(id: string, lockMs = 120_000): Promise<void> {
    await this.db.update(s.jobs).set({ lockedUntil: new Date(Date.now() + lockMs) }).where(and(eq(s.jobs.id, id), eq(s.jobs.state, 'active')));
  }

  async complete(id: string): Promise<void> {
    await this.db.update(s.jobs).set({ state: 'completed', finishedAt: new Date(), lockedBy: null, lockedUntil: null }).where(eq(s.jobs.id, id));
  }

  /** Fail a job; retried with backoff while attempts remain. */
  async fail(job: Job, error: string, retryDelayMs = 5000): Promise<'retry' | 'failed'> {
    if (job.attempts < job.maxAttempts) {
      await this.db.update(s.jobs).set({ state: 'created', error, lockedBy: null, lockedUntil: null, runAfter: new Date(Date.now() + retryDelayMs * job.attempts) }).where(eq(s.jobs.id, job.id));
      return 'retry';
    }
    await this.db.update(s.jobs).set({ state: 'failed', error, finishedAt: new Date(), lockedBy: null, lockedUntil: null }).where(eq(s.jobs.id, job.id));
    return 'failed';
  }

  async cancelWhere(queue: string, match: Record<string, string>): Promise<number> {
    const conds = Object.entries(match).map(([k, v]) => sql`payload ->> ${k} = ${v}`);
    const res = await this.db.execute(sql`update jobs set state = 'cancelled', finished_at = now() where queue = ${queue} and state in ('created') and ${sql.join(conds, sql` and `)} returning id`);
    return rowsOf(res).length;
  }

  /** Re-queue jobs whose worker vanished (lock expired). */
  async reapExpired(): Promise<number> {
    const rows = await this.db.update(s.jobs).set({ state: 'created', lockedBy: null, lockedUntil: null, error: 'worker lock expired' }).where(and(eq(s.jobs.state, 'active'), lt(s.jobs.lockedUntil, new Date()))).returning({ id: s.jobs.id });
    return rows.length;
  }

  async stats(queue?: string): Promise<Record<string, number>> {
    const res = await this.db.execute(sql`select state, count(*)::int as n from jobs ${queue ? sql`where queue = ${queue}` : sql``} group by state`);
    return Object.fromEntries(rowsOf<{ state: string; n: number }>(res).map((r) => [r.state, r.n]));
  }
}

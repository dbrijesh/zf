import { EventEmitter } from 'node:events';
import { eq, sql } from 'drizzle-orm';
import { tables as t, rowsOf, type Db } from '@zerovity/db';

export interface HubEvent { type: string; factoryId?: string; workItemId?: string; runId?: string; [k: string]: unknown }

/**
 * In-process pub/sub plus a database revision counter. Within one process (embedded mode) listeners fire
 * immediately; across processes the API polls `rev:<factoryId>` and the run event table, so both modes work.
 */
export class EventHub {
  private em = new EventEmitter().setMaxListeners(1000);
  emit(e: HubEvent): void { this.em.emit('event', e); }
  subscribe(fn: (e: HubEvent) => void): () => void {
    this.em.on('event', fn);
    return () => this.em.off('event', fn);
  }
}

export async function bumpRev(db: Db, factoryId: string): Promise<number> {
  const key = `rev:${factoryId}`;
  const res = await db.execute(sql`insert into kv (key, value, updated_at) values (${key}, '1'::jsonb, now())
    on conflict (key) do update set value = to_jsonb(coalesce((kv.value #>> '{}')::int, 0) + 1), updated_at = now() returning (value #>> '{}')::int as n`);
  return rowsOf<{ n: number }>(res)[0]?.n ?? 0;
}

export async function readRev(db: Db, factoryId: string): Promise<number> {
  const [r] = await db.select().from(t.kv).where(eq(t.kv.key, `rev:${factoryId}`));
  return Number(r?.value ?? 0);
}

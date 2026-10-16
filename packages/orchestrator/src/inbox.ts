import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { ulid, notFound } from '@zerovity/core';
import { tables as t, type Db } from '@zerovity/db';
import type { InboxRow } from './types';

export interface InboxCreate {
  orgId: string; factoryId?: string | null; userId?: string | null; workItemId?: string | null; kind: string; title: string; body?: string; payload?: Record<string, unknown>; refKey?: string;
}

export class Inbox {
  constructor(private db: Db) {}

  /** One open item per refKey: re-creating refreshes it instead of duplicating. */
  async create(i: InboxCreate): Promise<InboxRow> {
    if (i.refKey && i.workItemId) {
      const [ex] = await this.db.select().from(t.inboxItems).where(and(eq(t.inboxItems.workItemId, i.workItemId), eq(t.inboxItems.refKey, i.refKey), eq(t.inboxItems.status, 'open')));
      if (ex) {
        await this.db.update(t.inboxItems).set({ title: i.title, body: i.body ?? '', payload: i.payload ?? {}, read: false, updatedAt: new Date() }).where(eq(t.inboxItems.id, ex.id));
        return { ...ex, title: i.title, body: i.body ?? '', payload: i.payload ?? {} };
      }
    }
    const row = { id: ulid(), orgId: i.orgId, factoryId: i.factoryId ?? null, userId: i.userId ?? null, workItemId: i.workItemId ?? null, kind: i.kind, title: i.title, body: i.body ?? '', payload: i.payload ?? {}, refKey: i.refKey ?? null };
    await this.db.insert(t.inboxItems).values(row);
    const [r] = await this.db.select().from(t.inboxItems).where(eq(t.inboxItems.id, row.id));
    return r;
  }

  /** Resolve every open item of a work item whose refKey starts with the prefix ('' = all). */
  async resolveByRef(workItemId: string, refPrefix: string, resolution = 'auto', by?: string): Promise<number> {
    const rows = await this.db.update(t.inboxItems).set({ status: 'resolved', resolvedAt: new Date(), resolution, resolvedBy: by ?? null, updatedAt: new Date() })
      .where(and(eq(t.inboxItems.workItemId, workItemId), eq(t.inboxItems.status, 'open'), refPrefix ? like(t.inboxItems.refKey, `${refPrefix}%`) : sql`true`)).returning({ id: t.inboxItems.id });
    return rows.length;
  }

  async resolve(id: string, by: string, resolution = 'manual'): Promise<InboxRow> {
    await this.db.update(t.inboxItems).set({ status: 'resolved', resolvedAt: new Date(), resolvedBy: by, resolution, updatedAt: new Date() }).where(eq(t.inboxItems.id, id));
    return this.get(id);
  }
  async reopen(id: string): Promise<InboxRow> {
    await this.db.update(t.inboxItems).set({ status: 'open', resolvedAt: null, resolvedBy: null, resolution: null, updatedAt: new Date() }).where(eq(t.inboxItems.id, id));
    return this.get(id);
  }
  async markRead(id: string, read = true): Promise<void> {
    await this.db.update(t.inboxItems).set({ read }).where(eq(t.inboxItems.id, id));
  }
  async get(id: string): Promise<InboxRow> {
    const [r] = await this.db.select().from(t.inboxItems).where(eq(t.inboxItems.id, id));
    if (!r) throw notFound('Inbox item', id);
    return r;
  }

  async list(f: { orgId: string; userId?: string; factoryId?: string; kind?: string; status?: 'open' | 'resolved' | 'all'; unread?: boolean; q?: string; limit?: number }): Promise<InboxRow[]> {
    const conds = [eq(t.inboxItems.orgId, f.orgId)];
    if (f.userId) conds.push(or(eq(t.inboxItems.userId, f.userId), sql`${t.inboxItems.userId} is null`)!);
    if (f.factoryId) conds.push(eq(t.inboxItems.factoryId, f.factoryId));
    if (f.kind) conds.push(eq(t.inboxItems.kind, f.kind));
    if ((f.status ?? 'open') !== 'all') conds.push(eq(t.inboxItems.status, f.status ?? 'open'));
    if (f.unread) conds.push(eq(t.inboxItems.read, false));
    if (f.q) conds.push(or(sql`${t.inboxItems.title} ilike ${'%' + f.q + '%'}`, sql`${t.inboxItems.body} ilike ${'%' + f.q + '%'}`)!);
    return this.db.select().from(t.inboxItems).where(and(...conds)).orderBy(desc(t.inboxItems.createdAt)).limit(f.limit ?? 200);
  }

  async counts(orgId: string, userId?: string): Promise<{ open: number; unread: number; byKind: Record<string, number> }> {
    const rows = await this.list({ orgId, userId, status: 'open', limit: 1000 });
    const byKind: Record<string, number> = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    return { open: rows.length, unread: rows.filter((r) => !r.read).length, byKind };
  }
}

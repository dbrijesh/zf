import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import path from 'node:path';
import { ulid, notFound, invalid, estimateTokens, type ContextItemInput, type ContextLayer } from '@zerovity/core';
import { tables as t, type Db, type ArtifactStore, appendAudit } from '@zerovity/db';
import { assembleContext, buildItemBody, convertFile, fetchSnapshot, summarise, toRecord, repoConventionItems, type ContextBundle, type ContextItemRecord, type QaEntry, type ConvertOptions } from '@zerovity/context';

export type ContextRow = typeof t.contextItems.$inferSelect;
export interface ContextFilter { orgId: string; layer?: string; scopeId?: string; kind?: string; tag?: string; q?: string; scopes?: Array<{ layer: string; scopeId: string }> }

export class ContextService {
  constructor(private db: Db, private artifacts: ArtifactStore, private opts: { allowPrivateUrls?: boolean; fetchImpl?: typeof fetch; convert?: ConvertOptions; audit?: boolean } = {}) {}

  private async audit(orgId: string, factoryId: string | null, actor: string, action: string, subject: string, payload: unknown) {
    if (this.opts.audit === false) return;
    await appendAudit(this.db, { chain: factoryId ?? `org:${orgId}`, factoryId, actor, action, subject, payload });
  }

  async list(f: ContextFilter): Promise<ContextRow[]> {
    const conds = [eq(t.contextItems.orgId, f.orgId), isNull(t.contextItems.deletedAt)];
    if (f.layer) conds.push(eq(t.contextItems.layer, f.layer));
    if (f.scopeId !== undefined) conds.push(eq(t.contextItems.scopeId, f.scopeId));
    if (f.kind) conds.push(eq(t.contextItems.kind, f.kind));
    if (f.scopes?.length) conds.push(or(...f.scopes.map((s) => and(eq(t.contextItems.layer, s.layer), eq(t.contextItems.scopeId, s.scopeId))))!);
    let rows = await this.db.select().from(t.contextItems).where(and(...conds)).orderBy(desc(t.contextItems.updatedAt));
    if (f.tag) rows = rows.filter((r) => r.tags.includes(f.tag!));
    if (f.q) {
      const q = f.q.toLowerCase();
      rows = rows.filter((r) => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q) || r.tags.some((x) => x.toLowerCase().includes(q)));
    }
    return rows;
  }

  async get(id: string): Promise<ContextRow> {
    const [r] = await this.db.select().from(t.contextItems).where(eq(t.contextItems.id, id));
    if (!r || r.deletedAt) throw notFound('Context item', id);
    return r;
  }

  async create(orgId: string, input: ContextItemInput, by: string, factoryId: string | null = null): Promise<ContextRow> {
    const { body, summary, tokenCount, parsed } = buildItemBody(input);
    const id = ulid();
    const scopeId = parsed.layer === 'org' ? orgId : parsed.scopeId;
    await this.db.insert(t.contextItems).values({ id, orgId, layer: parsed.layer, scopeId, kind: parsed.kind, title: parsed.title, body, summary, tags: parsed.tags, appliesTo: parsed.appliesTo, priority: parsed.priority, tokenCount, meta: parsed.meta, createdBy: by });
    await this.db.insert(t.contextItemVersions).values({ id: ulid(), itemId: id, version: 1, title: parsed.title, body, changedBy: by });
    await this.audit(orgId, factoryId, by, 'context.created', id, { layer: parsed.layer, scopeId, kind: parsed.kind, title: parsed.title, tokenCount });
    return this.get(id);
  }

  /** Files are converted to Markdown at upload; the original is kept in the artifact store. */
  async attachFile(orgId: string, a: { layer: ContextLayer; scopeId: string; name: string; data: Buffer; title?: string; priority?: 'always' | 'relevant' | 'on_request'; tags?: string[]; appliesTo?: { phases: string[]; agents: string[] }; factoryId?: string | null }, by: string): Promise<ContextRow> {
    const conv = await convertFile(a.data, a.name, this.opts.convert);
    const id = ulid();
    const key = `context/${id}/${path.basename(a.name).replace(/[^\w.\-]+/g, '_')}`;
    await this.artifacts.put(key, a.data);
    const body = conv.markdown;
    const tokenCount = estimateTokens(body);
    const priority = a.priority ?? (tokenCount > 3000 ? 'relevant' : 'always');
    await this.db.insert(t.contextItems).values({ id, orgId, layer: a.layer, scopeId: a.layer === 'org' ? orgId : a.scopeId, kind: 'file', title: a.title ?? a.name, body, summary: summarise(body) || a.name, tags: a.tags ?? [], appliesTo: a.appliesTo ?? { phases: [], agents: [] }, priority, tokenCount, artifactKey: key, meta: { originalName: a.name, bytes: a.data.length, convertedAs: conv.kind, described: conv.described, warnings: conv.warnings }, createdBy: by });
    await this.db.insert(t.contextItemVersions).values({ id: ulid(), itemId: id, version: 1, title: a.title ?? a.name, body, changedBy: by });
    await this.audit(orgId, a.factoryId ?? null, by, 'context.file_attached', id, { name: a.name, bytes: a.data.length, layer: a.layer, tokenCount });
    return this.get(id);
  }

  async attachUrl(orgId: string, a: { layer: ContextLayer; scopeId: string; url: string; title?: string; priority?: 'always' | 'relevant' | 'on_request'; tags?: string[]; factoryId?: string | null }, by: string): Promise<ContextRow> {
    const snap = await fetchSnapshot(a.url, { allowPrivate: this.opts.allowPrivateUrls, fetchImpl: this.opts.fetchImpl });
    const body = `Source: ${snap.finalUrl} (snapshot ${snap.fetchedAt})\n\n${snap.markdown}`;
    const row = await this.create(orgId, { layer: a.layer, scopeId: a.scopeId, title: a.title ?? snap.title, kind: 'url', body, tags: a.tags ?? [], priority: a.priority ?? (estimateTokens(body) > 3000 ? 'relevant' : 'always'), meta: { url: a.url, fetchedAt: snap.fetchedAt, etag: snap.etag } }, by, a.factoryId ?? null);
    return row;
  }

  async refreshUrl(id: string, by: string): Promise<ContextRow> {
    const it = await this.get(id);
    const url = (it.meta as { url?: string }).url;
    if (it.kind !== 'url' || !url) throw invalid('Only URL items can be refreshed');
    const snap = await fetchSnapshot(url, { allowPrivate: this.opts.allowPrivateUrls, fetchImpl: this.opts.fetchImpl });
    return this.update(id, { body: `Source: ${snap.finalUrl} (snapshot ${snap.fetchedAt})\n\n${snap.markdown}`, meta: { ...it.meta, fetchedAt: snap.fetchedAt, etag: snap.etag } }, by);
  }

  async update(id: string, patch: Partial<{ title: string; body: string; tags: string[]; priority: string; appliesTo: { phases: string[]; agents: string[] }; enabled: boolean; meta: Record<string, unknown> }>, by: string): Promise<ContextRow> {
    const cur = await this.get(id);
    const body = patch.body ?? cur.body;
    const title = patch.title ?? cur.title;
    const changed = body !== cur.body || title !== cur.title;
    const version = changed ? cur.version + 1 : cur.version;
    await this.db.update(t.contextItems).set({ title, body, summary: changed ? summarise(body) || title : cur.summary, tokenCount: estimateTokens(body), tags: patch.tags ?? cur.tags, priority: patch.priority ?? cur.priority, appliesTo: patch.appliesTo ?? cur.appliesTo, enabled: patch.enabled ?? cur.enabled, meta: patch.meta ?? cur.meta, version, updatedAt: new Date() }).where(eq(t.contextItems.id, id));
    if (changed) await this.db.insert(t.contextItemVersions).values({ id: ulid(), itemId: id, version, title, body, changedBy: by });
    await this.audit(cur.orgId, null, by, 'context.updated', id, { version, fields: Object.keys(patch) });
    return this.get(id);
  }

  async remove(id: string, by: string): Promise<void> {
    const cur = await this.get(id);
    await this.db.update(t.contextItems).set({ deletedAt: new Date() }).where(eq(t.contextItems.id, id));
    await this.audit(cur.orgId, null, by, 'context.deleted', id, { title: cur.title });
  }

  async versions(id: string) {
    return this.db.select().from(t.contextItemVersions).where(eq(t.contextItemVersions.itemId, id)).orderBy(desc(t.contextItemVersions.version));
  }

  async restoreVersion(id: string, version: number, by: string): Promise<ContextRow> {
    const [v] = await this.db.select().from(t.contextItemVersions).where(and(eq(t.contextItemVersions.itemId, id), eq(t.contextItemVersions.version, version)));
    if (!v) throw notFound('Version', String(version));
    return this.update(id, { title: v.title, body: v.body }, by);
  }

  async originalFile(id: string): Promise<{ name: string; data: Buffer } | undefined> {
    const it = await this.get(id);
    if (!it.artifactKey) return undefined;
    const data = await this.artifacts.get(it.artifactKey);
    return data ? { name: (it.meta as { originalName?: string }).originalName ?? 'file', data } : undefined;
  }

  async setToggle(workItemId: string, itemId: string, enabled: boolean): Promise<void> {
    await this.db.insert(t.workItemContextToggles).values({ workItemId, itemId, enabled }).onConflictDoUpdate({ target: [t.workItemContextToggles.workItemId, t.workItemContextToggles.itemId], set: { enabled } });
  }

  async toggles(workItemId: string): Promise<Record<string, boolean>> {
    const rows = await this.db.select().from(t.workItemContextToggles).where(eq(t.workItemContextToggles.workItemId, workItemId));
    return Object.fromEntries(rows.map((r) => [r.itemId, r.enabled]));
  }

  /** The question and answer history plus reviewer feedback an agent must see when resumed. */
  async qaFor(workItemId: string): Promise<QaEntry[]> {
    const qs = await this.db.select().from(t.questions).where(eq(t.questions.workItemId, workItemId)).orderBy(asc(t.questions.createdAt));
    const gates = await this.db.select().from(t.gates).where(and(eq(t.gates.workItemId, workItemId), inArray(t.gates.status, ['changes_requested', 'approved', 'rejected']))).orderBy(asc(t.gates.requestedAt));
    const qa: QaEntry[] = qs.map((q) => ({ question: q.text, kind: q.kind, answer: q.answer ?? undefined, answeredBy: q.answeredBy ?? undefined, answeredAt: q.answeredAt ?? undefined, phase: q.phase ?? undefined, asker: q.askedBy ?? undefined }));
    for (const g of gates) {
      const text = [g.reason, ...g.comments.map((c) => `${c.file ? `${c.file}${c.line ? `:${c.line}` : ''}: ` : ''}${c.text}`)].filter(Boolean).join('\n');
      if (g.status === 'changes_requested' || (g.reason && g.status === 'approved')) qa.push({ question: `Reviewer decision on ${g.type}: ${g.status.replace('_', ' ')}`, kind: 'gate', answer: text || g.status, answeredBy: g.decidedBy ?? undefined, answeredAt: g.decidedAt ?? undefined });
    }
    return qa;
  }

  /** Items that could apply to this work item (query only; the assembler does the filtering). */
  async candidatesFor(w: { id: string; factoryId: string; orgId: string; repoKey?: string }): Promise<ContextItemRecord[]> {
    const rows = await this.db.select().from(t.contextItems).where(and(eq(t.contextItems.orgId, w.orgId), isNull(t.contextItems.deletedAt), or(eq(t.contextItems.layer, 'org'), and(eq(t.contextItems.layer, 'factory'), eq(t.contextItems.scopeId, w.factoryId)), and(eq(t.contextItems.layer, 'repo'), eq(t.contextItems.scopeId, w.repoKey ?? '')), and(eq(t.contextItems.layer, 'workItem'), eq(t.contextItems.scopeId, w.id)), and(eq(t.contextItems.layer, 'phase'), sql`${t.contextItems.scopeId} like ${w.id + ':%'}`))));
    return rows.map(toRecord);
  }

  /** "What the agent sees" preview (spec 9.5) without a worktree; repo convention files are added by the worker at run time. */
  async preview(workItemId: string, agent: { name: string; phase: string; contextScopes: string[]; tokenBudget?: number }, extraRepoFiles: Array<{ path: string; content: string }> = []): Promise<ContextBundle> {
    const [w] = await this.db.select().from(t.workItems).where(eq(t.workItems.id, workItemId));
    if (!w) throw notFound('Work item', workItemId);
    const [f] = await this.db.select().from(t.factories).where(eq(t.factories.id, w.factoryId));
    const [repo] = w.repoId ? await this.db.select().from(t.repositories).where(eq(t.repositories.id, w.repoId)) : [];
    const repoKey = repo ? `${repo.owner}/${repo.name}` : undefined;
    const items = await this.candidatesFor({ id: w.id, factoryId: w.factoryId, orgId: f.orgId, repoKey });
    return assembleContext({ items, agent, workItem: { id: w.id, shortId: w.shortId, title: w.title, body: w.body, factoryId: w.factoryId, repoKey }, qa: await this.qaFor(w.id), toggles: await this.toggles(w.id), extra: repoConventionItems(extraRepoFiles, repoKey ?? '') });
  }

  /** Factory-level context declared in the definition (context/*.md|yaml) mirrors into the library as read-only items. */
  async syncDefinitionItems(orgId: string, factoryId: string, items: Array<{ name: string; title: string; layer: ContextLayer; kind: string; body: string; tags: string[]; priority: string; appliesTo: { phases: string[]; agents: string[] }; meta?: Record<string, unknown> }>): Promise<void> {
    const existing = await this.db.select().from(t.contextItems).where(and(eq(t.contextItems.orgId, orgId), isNull(t.contextItems.deletedAt)));
    const mine = existing.filter((e) => (e.meta as { definitionKey?: string }).definitionKey?.startsWith(`${factoryId}:`));
    const seen = new Set<string>();
    for (const it of items) {
      const key = `${factoryId}:${it.name}`;
      seen.add(key);
      const input: ContextItemInput = { layer: it.layer, scopeId: it.layer === 'factory' ? factoryId : it.layer === 'org' ? orgId : '', title: it.title, kind: it.kind as ContextItemInput['kind'], body: it.body, tags: it.tags, appliesTo: it.appliesTo as never, priority: it.priority as 'always', meta: { ...it.meta, definitionKey: key } };
      const ex = mine.find((m) => (m.meta as { definitionKey?: string }).definitionKey === key);
      if (ex) {
        const { body, tokenCount, summary } = buildItemBody(input);
        if (ex.body !== body || ex.title !== it.title) await this.db.update(t.contextItems).set({ title: it.title, body, summary, tokenCount, tags: it.tags, priority: it.priority, appliesTo: it.appliesTo, version: ex.version + 1, updatedAt: new Date() }).where(eq(t.contextItems.id, ex.id));
      } else await this.create(orgId, input, 'definition', factoryId);
    }
    for (const m of mine) if (!seen.has((m.meta as { definitionKey: string }).definitionKey)) await this.db.update(t.contextItems).set({ deletedAt: new Date() }).where(eq(t.contextItems.id, m.id));
  }
}

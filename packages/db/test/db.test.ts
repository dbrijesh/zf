import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ulid } from '@zerovity/core';
import { createDb, tables as t, appendAudit, readChain, verifyAudit, JobQueue, SecretBox, DbSecrets, SecretResolver, nextShortId, appendRunEvents, FsArtifactStore, computeCost, seedPrices, priceFor, kvGet, kvSet, eq, sql, type DbHandle } from '../src';

let h: DbHandle;
const orgId = ulid();
const factoryId = ulid();

beforeAll(async () => {
  h = await createDb();
  await h.db.insert(t.orgs).values({ id: orgId, name: 'Acme', slug: 'acme' });
  await h.db.insert(t.factories).values({ id: factoryId, orgId, name: 'pay', shortPrefix: 'ZF', nextSeq: 200 });
}, 60_000);
afterAll(async () => h.close());

describe('migrations and basics', () => {
  it('runs on embedded postgres and short ids are atomic and sequential', async () => {
    expect(h.kind).toBe('pglite');
    const ids = await Promise.all([nextShortId(h.db, factoryId), nextShortId(h.db, factoryId), nextShortId(h.db, factoryId)]);
    expect(new Set(ids.map((i) => i.shortId)).size).toBe(3);
    expect(ids.map((i) => i.seq).sort()).toEqual([200, 201, 202]);
  });
  it('kv and run events', async () => {
    await kvSet(h.db, 'k', { a: 1 });
    await kvSet(h.db, 'k', { a: 2 });
    expect(await kvGet(h.db, 'k')).toEqual({ a: 2 });
    const wi = ulid(), run = ulid();
    await h.db.insert(t.workItems).values({ id: wi, factoryId, shortId: 'ZF-1', seq: 1, title: 'x' });
    await h.db.insert(t.runs).values({ id: run, workItemId: wi, factoryId, agentName: 'a', phase: 'BUILD', harness: 'fake' });
    expect(await appendRunEvents(h.db, run, 1, [{ kind: 'message.assistant', payload: { text: 'key sk-ant-api03-abcdefghijklmnop1234' } }, { kind: 'usage', payload: {} }])).toBe(2);
    const rows = await h.db.select().from(t.runEvents).where(eq(t.runEvents.runId, run));
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows[0].payload)).toContain('REDACTED');
  });
});

describe('audit log', () => {
  it('chains concurrently appended entries and verifies', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => appendAudit(h.db, { chain: factoryId, factoryId, actor: 'u', action: 'x' + i, subject: 's', payload: { i } })));
    const chain = await readChain(h.db, factoryId);
    expect(chain.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await verifyAudit(h.db, factoryId)).toEqual({ ok: true, checked: 8 });
  });
  it('is append-only at the database level', async () => {
    await expect(h.db.execute(sql`update audit_log set actor = 'evil'`)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } });
    await expect(h.db.execute(sql`delete from audit_log`)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } });
  });
  it('redacts secrets in payloads before storing', async () => {
    const e = await appendAudit(h.db, { chain: factoryId, factoryId, actor: 'u', action: 'secret.set', subject: 'S', payload: { token: 'abc', note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } });
    expect(JSON.stringify(e.payload)).not.toContain('ghp_');
    expect(await verifyAudit(h.db, factoryId)).toMatchObject({ ok: true });
  });
});

describe('job queue', () => {
  it('claims each job exactly once, orders by priority, honours singleton and retry', async () => {
    const q = new JobQueue(h.db);
    await q.enqueue('t', { n: 1 });
    await q.enqueue('t', { n: 2 }, { priority: 5 });
    expect(await q.enqueue('t', { n: 3 }, { singletonKey: 'k' })).toBeTruthy();
    expect(await q.enqueue('t', { n: 4 }, { singletonKey: 'k' })).toBeNull();
    const claims = await Promise.all([q.claim('t', 'w1'), q.claim('t', 'w2'), q.claim('t', 'w3'), q.claim('t', 'w4')]);
    const got = claims.filter(Boolean);
    expect(got).toHaveLength(3);
    expect(new Set(got.map((j) => j!.id)).size).toBe(3);
    const first = got.find((j) => j!.payload.n === 2)!;
    await q.complete(first.id);
    const j = got.find((j) => j!.payload.n === 1)!;
    expect(await q.fail(j, 'boom')).toBe('failed'); // maxAttempts 1
    expect((await q.stats('t')).completed).toBe(1);
  });
  it('retries with attempts left, reaps expired locks, cancels by payload', async () => {
    const q = new JobQueue(h.db);
    await q.enqueue('r', { x: 'a' }, { maxAttempts: 3 });
    const j = (await q.claim('r', 'w', 1))!;
    expect(await q.fail(j, 'e', 0)).toBe('retry');
    const j2 = (await q.claim('r', 'w', 1))!;
    expect(j2.attempts).toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(await q.reapExpired()).toBe(1);
    expect(await q.cancelWhere('r', { x: 'a' })).toBe(1);
    expect(await q.claim('r', 'w')).toBeUndefined();
  });
  it('does not claim future jobs', async () => {
    const q = new JobQueue(h.db);
    await q.enqueue('f', {}, { runAfter: new Date(Date.now() + 60_000) });
    expect(await q.claim('f', 'w')).toBeUndefined();
  });
});

describe('secrets', () => {
  const box = new SecretBox(Buffer.alloc(32, 7));
  it('envelope encrypts and round trips; tampering fails', () => {
    const sealed = box.seal('hunter2-value');
    expect(sealed).not.toContain('hunter2');
    expect(box.open(sealed)).toBe('hunter2-value');
    expect(box.seal('hunter2-value')).not.toBe(sealed);
    const o = JSON.parse(sealed);
    o.ct = Buffer.from('xxxxxxxxxxxxxxxx').toString('base64');
    expect(() => box.open(JSON.stringify(o))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 8)).open(sealed)).toThrow();
  });
  it('stores, never lists values, resolves factory over org', async () => {
    const store = new DbSecrets(h.db, box);
    await store.set('org', orgId, 'API', 'org-value-1234');
    await store.set('factory', factoryId, 'API', 'factory-value-9999');
    await store.set('org', orgId, 'ONLY_ORG', 'zzzz1111');
    await store.set('org', orgId, 'API', 'org-value-5678'); // update path
    const list = await store.list('org', orgId);
    expect(JSON.stringify(list)).not.toContain('org-value');
    expect(list.find((x) => x.name === 'API')?.last4).toBe('5678');
    const r = await new SecretResolver(store, orgId, factoryId).resolve(['API', 'ONLY_ORG', 'NOPE']);
    expect(r).toEqual({ API: 'factory-value-9999', ONLY_ORG: 'zzzz1111' });
    const raw = await h.db.select().from(t.secrets);
    expect(JSON.stringify(raw)).not.toContain('factory-value');
  });
});

describe('artifacts and prices', () => {
  it('fs artifact store round trips and rejects traversal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-art-'));
    const s = new FsArtifactStore(dir);
    await s.put('a/b/c.txt', 'hi');
    expect((await s.get('a/b/c.txt'))?.toString()).toBe('hi');
    expect(await s.list('a')).toEqual(['a/b/c.txt']);
    await expect(s.put('../x', 'no')).rejects.toThrow(/invalid/);
    await s.delete('a/b/c.txt');
    expect(await s.get('a/b/c.txt')).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('computes cost from the price table unless the harness reported one', async () => {
    await seedPrices(h.db);
    const p = await priceFor(h.db, 'claude-sonnet-5-5');
    expect(computeCost({ inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0 }, p)).toBeCloseTo(18);
    expect(computeCost({ inputTokens: 5, outputTokens: 5, cachedTokens: 0, costUsd: 0.5 }, p)).toBe(0.5);
    const cp = await priceFor(h.db, undefined, 'copilot');
    expect(computeCost({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, premiumRequests: 10 }, cp)).toBeCloseTo(0.4);
  });
});

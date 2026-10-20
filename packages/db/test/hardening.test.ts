import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ulid, isUniqueViolation } from '@zerovity/core';
import { createDb, tables as t, SecretBox, DbSecrets, secretAad, tryLease, eq, type DbHandle } from '../src';

let h: DbHandle;
const orgId = ulid();
const factoryId = ulid();
beforeAll(async () => {
  h = await createDb();
  await h.db.insert(t.orgs).values({ id: orgId, name: 'Acme', slug: 'acme-h' });
  await h.db.insert(t.factories).values({ id: factoryId, orgId, name: 'pay-h', shortPrefix: 'ZH', nextSeq: 1 });
}, 60_000);
afterAll(async () => h.close());

describe('secrets are bound to where they belong', () => {
  const box = new SecretBox(Buffer.alloc(32, 3));
  it('a value sealed for one place does not open for another', () => {
    const aad = secretAad('connection', 'c1', 'private_key');
    const sealed = box.seal('s3cret', aad);
    expect(box.open(sealed, aad)).toBe('s3cret');
    expect(() => box.open(sealed, secretAad('connection', 'c2', 'private_key'))).toThrow();
    expect(() => box.open(sealed, secretAad('connection', 'c1', 'webhook_secret'))).toThrow();
    expect(() => box.open(sealed)).toThrow(/bound/);
  });
  it('values sealed by older versions (no binding) still open', () => {
    const legacy = box.seal('old-value');
    expect(JSON.parse(legacy).v).toBe(1);
    expect(box.open(legacy)).toBe('old-value');
    expect(box.open(legacy, secretAad('org', 'o', 'x'))).toBe('old-value');
  });
  it('copying one stored secret onto another row breaks it instead of leaking it there', async () => {
    const store = new DbSecrets(h.db, box);
    await store.set('connection', 'conn-a', 'token', 'AAAA-secret');
    await store.set('connection', 'conn-b', 'token', 'BBBB-secret');
    expect(await store.get('connection', 'conn-a', 'token')).toBe('AAAA-secret');
    const [a] = await h.db.select().from(t.secrets).where(eq(t.secrets.scopeId, 'conn-a'));
    await h.db.update(t.secrets).set({ ciphertext: a.ciphertext }).where(eq(t.secrets.scopeId, 'conn-b'));
    await expect(store.get('connection', 'conn-b', 'token')).rejects.toThrow();
  });
});

describe('leases: periodic work runs on one process at a time', () => {
  it('only one owner holds a lease; the owner can renew; a dead owner lapses', async () => {
    const t0 = 1_000_000;
    expect(await tryLease(h.db, 'sched', 'api-1', 60_000, t0)).toBe(true);
    expect(await tryLease(h.db, 'sched', 'api-2', 60_000, t0 + 1_000)).toBe(false);
    expect(await tryLease(h.db, 'sched', 'api-1', 60_000, t0 + 30_000)).toBe(true); // renewed
    expect(await tryLease(h.db, 'sched', 'api-2', 60_000, t0 + 80_000)).toBe(false); // still inside the renewed lease
    expect(await tryLease(h.db, 'sched', 'api-2', 60_000, t0 + 95_000)).toBe(true); // api-1 stopped renewing
    expect(await tryLease(h.db, 'other', 'api-2', 60_000, t0)).toBe(true); // leases are per name
  });
  it('two processes racing for a lease: exactly one wins', async () => {
    const wins = await Promise.all(['a', 'b', 'c', 'd'].map((o) => tryLease(h.db, 'race', o, 60_000, 5_000_000)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
});

describe('one open work item per external source', () => {
  const wi = (n: number, over: Record<string, unknown> = {}) => ({ id: ulid(), factoryId, shortId: `ZH-${n}`, seq: n, title: 'x', sourceType: 'github', sourceRef: 'o/r#1', ...over });
  it('a second open item for the same source is rejected by the database', async () => {
    await h.db.insert(t.workItems).values(wi(1));
    let err: unknown;
    try { await h.db.insert(t.workItems).values(wi(2)); } catch (e) { err = e; }
    expect(isUniqueViolation(err)).toBe(true);
  });
  it('a finished item does not block a new one for the same issue (re-labelling after a failure)', async () => {
    await h.db.update(t.workItems).set({ state: 'FAILED' }).where(eq(t.workItems.shortId, 'ZH-1'));
    await h.db.insert(t.workItems).values(wi(3));
    await h.db.update(t.workItems).set({ state: 'COMPLETE' }).where(eq(t.workItems.shortId, 'ZH-3'));
    await h.db.insert(t.workItems).values(wi(4));
  });
  it('items without a source reference (web form) are unrestricted, and other sources are independent', async () => {
    await h.db.insert(t.workItems).values(wi(5, { sourceType: 'web', sourceRef: null }));
    await h.db.insert(t.workItems).values(wi(6, { sourceType: 'web', sourceRef: null }));
    await h.db.insert(t.workItems).values(wi(7, { sourceRef: 'o/r#2' }));
  });
  it('concurrent inserts of the same source: exactly one wins', async () => {
    const results = await Promise.allSettled([8, 9, 10, 11].map((n) => h.db.insert(t.workItems).values(wi(n, { sourceRef: 'o/r#race' }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => isUniqueViolation((r as PromiseRejectedResult).reason))).toBe(true);
  });
});

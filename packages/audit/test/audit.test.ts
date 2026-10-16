import { describe, it, expect } from 'vitest';
import { buildEntry, verifyChain, toCsv, toJsonl, type AuditEntry } from '../src';

function chain(n: number): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (let i = 0; i < n; i++) out.push(buildEntry(out[i - 1], { chain: 'f1', factoryId: 'f1', actor: 'u', action: 'a' + i, subject: 's', payload: { i } }, 'id' + i, '2026-01-01T00:00:0' + i + 'Z'));
  return out;
}

describe('audit chain', () => {
  it('verifies an intact chain', () => {
    expect(verifyChain(chain(5))).toEqual({ ok: true, checked: 5 });
  });
  it('detects payload tampering', () => {
    const c = chain(4);
    c[2] = { ...c[2], payload: { i: 99 } };
    expect(verifyChain(c)).toMatchObject({ ok: false, brokenAt: 3, reason: 'payload_hash_mismatch' });
  });
  it('detects entry field tampering', () => {
    const c = chain(4);
    c[1] = { ...c[1], actor: 'mallory' };
    expect(verifyChain(c)).toMatchObject({ ok: false, brokenAt: 2, reason: 'hash_mismatch' });
  });
  it('detects removed entries and relinked hashes', () => {
    const c = chain(4);
    expect(verifyChain([c[0], c[2], c[3]])).toMatchObject({ ok: false, reason: 'seq_gap' });
  });
  it('detects a rewritten prev hash', () => {
    const c = chain(3);
    c[1] = { ...c[1], prevHash: 'f'.repeat(64) };
    expect(verifyChain(c).ok).toBe(false);
  });
  it('accepts a window that starts mid chain (pagination)', () => {
    const c = chain(5);
    expect(verifyChain(c.slice(2)).ok).toBe(true);
  });
  it('exports jsonl and csv', () => {
    const c = chain(2);
    expect(toJsonl(c).trim().split('\n')).toHaveLength(2);
    expect(toCsv(c).split('\n')[0]).toContain('seq,ts,actor');
  });
});

import { describe, it, expect } from 'vitest';
import { ulid, ulidTime, slugify, redactText, redactValue, estimateTokens, canonicalJson, ResultSchema, median } from '../src';

describe('ids', () => {
  it('ulids are 26 chars, sortable and monotonic', () => {
    const a = ulid(1000);
    const b = ulid(1000);
    const c = ulid(2000);
    expect(a).toHaveLength(26);
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
    expect(ulidTime(c)).toBe(2000);
  });
  it('slugify', () => {
    expect(slugify('Two-step approval for refunds > $10k!')).toBe('two-step-approval-for-refunds-10k');
    expect(slugify('***')).toBe('item');
  });
});

describe('redaction', () => {
  it('redacts known token shapes', () => {
    const s = 'key sk-ant-api03-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz0123456789 and Bearer abcdefghijklmnopqrstuvwxyz';
    const r = redactText(s);
    expect(r).not.toMatch(/sk-ant-api03/);
    expect(r).not.toMatch(/ghp_abc/);
    expect(r).toContain('Bearer [REDACTED]');
  });
  it('redacts assignments and high entropy strings, keeps git shas', () => {
    expect(redactText('API_KEY=abcd1234efgh5678')).toContain('[REDACTED]');
    const sha = 'a'.repeat(40);
    expect(redactText(`commit ${sha}`)).toContain(sha);
    expect(redactText('x Zk3Q9vL2mB7xR4tW8nC1pY6hD5sF0gJaEuV')).toContain('REDACTED:high-entropy');
  });
  it('redacts secret-named keys in objects', () => {
    expect(redactValue({ authorization: 'abc', nested: { password: 'x', ok: 'fine' } })).toEqual({ authorization: '[REDACTED]', nested: { password: '[REDACTED]', ok: 'fine' } });
  });
});

describe('misc', () => {
  it('tokens grow with text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world '.repeat(100))).toBeGreaterThan(estimateTokens('hello world'));
  });
  it('canonical json is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('result schema applies defaults and rejects unknown status', () => {
    const r = ResultSchema.parse({ status: 'done' });
    expect(r.questions).toEqual([]);
    expect(() => ResultSchema.parse({ status: 'nope' })).toThrow();
  });
});

import { createHash } from 'node:crypto';
import { canonicalJson } from '@zerovity/core';

export const GENESIS = '0'.repeat(64);

export interface AuditEntry {
  id: string;
  seq: number;
  chain: string; // factory id, or "_org" for org-wide entries
  factoryId: string | null;
  actor: string;
  action: string;
  subject: string;
  payload: unknown;
  payloadHash: string;
  prevHash: string;
  hash: string;
  ts: string; // ISO
}

export type AuditInput = {
  chain: string;
  factoryId?: string | null;
  actor: string;
  action: string;
  subject: string;
  payload?: unknown;
};

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

export const hashPayload = (payload: unknown): string => sha256(canonicalJson(payload ?? null));

/** hash = sha256(prev_hash + canonical_json(entry)) - spec section 14 */
export function computeEntryHash(prevHash: string, e: Pick<AuditEntry, 'seq' | 'chain' | 'factoryId' | 'actor' | 'action' | 'subject' | 'payloadHash' | 'ts'>): string {
  return sha256(prevHash + canonicalJson({ seq: e.seq, chain: e.chain, factoryId: e.factoryId, actor: e.actor, action: e.action, subject: e.subject, payloadHash: e.payloadHash, ts: e.ts }));
}

export function buildEntry(prev: Pick<AuditEntry, 'seq' | 'hash'> | undefined, input: AuditInput, id: string, ts = new Date().toISOString()): AuditEntry {
  const seq = (prev?.seq ?? 0) + 1;
  const prevHash = prev?.hash ?? GENESIS;
  const payloadHash = hashPayload(input.payload);
  const base = { seq, chain: input.chain, factoryId: input.factoryId ?? null, actor: input.actor, action: input.action, subject: input.subject, payloadHash, ts };
  return { id, ...base, payload: input.payload ?? null, prevHash, hash: computeEntryHash(prevHash, base) };
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  brokenAt?: number;
  reason?: 'prev_hash_mismatch' | 'hash_mismatch' | 'payload_hash_mismatch' | 'seq_gap';
}

/** Verify an ordered chain. Returns the first broken sequence number if tampering is detected. */
export function verifyChain(entries: AuditEntry[]): VerifyResult {
  let prev = GENESIS;
  let expectSeq = entries.length ? entries[0].seq : 1;
  for (const e of entries) {
    if (e.seq !== expectSeq) return { ok: false, checked: e.seq - 1, brokenAt: e.seq, reason: 'seq_gap' };
    if (e.prevHash !== prev && !(e === entries[0] && e.seq > 1)) return { ok: false, checked: e.seq - 1, brokenAt: e.seq, reason: 'prev_hash_mismatch' };
    if (hashPayload(e.payload) !== e.payloadHash) return { ok: false, checked: e.seq - 1, brokenAt: e.seq, reason: 'payload_hash_mismatch' };
    if (computeEntryHash(e.prevHash, e) !== e.hash) return { ok: false, checked: e.seq - 1, brokenAt: e.seq, reason: 'hash_mismatch' };
    prev = e.hash;
    expectSeq = e.seq + 1;
  }
  return { ok: true, checked: entries.length };
}

export function toJsonl(entries: AuditEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}

const csvCell = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(entries: AuditEntry[]): string {
  const cols = ['seq', 'ts', 'actor', 'action', 'subject', 'payloadHash', 'prevHash', 'hash'] as const;
  return [cols.join(','), ...entries.map((e) => cols.map((c) => csvCell(e[c])).join(','))].join('\n') + '\n';
}

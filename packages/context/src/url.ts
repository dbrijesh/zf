import dns from 'node:dns/promises';
import net from 'node:net';
import { invalid } from '@zerovity/core';
import { htmlToMarkdown } from './convert';

export interface Snapshot { url: string; finalUrl: string; title: string; markdown: string; fetchedAt: string; status: number; contentType: string; etag?: string }

/** Block loopback, link-local and private ranges so a URL context item cannot be used for SSRF. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:') && isPrivateIp(l.slice(7));
}

export interface FetchOptions { allowPrivate?: boolean; maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch; headers?: Record<string, string>; lookup?: (host: string) => Promise<string[]> }

export async function fetchSnapshot(url: string, o: FetchOptions = {}): Promise<Snapshot> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw invalid('Only http and https URLs can be attached');
  if (!o.allowPrivate) {
    const addrs = net.isIP(u.hostname) ? [u.hostname] : await (o.lookup ?? (async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address)))(u.hostname);
    if (!addrs.length || addrs.some(isPrivateIp)) throw invalid(`Refusing to fetch ${u.hostname}: address is private or unresolved`);
  }
  const f = o.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
  try {
    const r = await f(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'ZerovityFactory/0.1 (+context snapshot)', accept: 'text/html,text/markdown,text/plain,application/json;q=0.9', ...o.headers } });
    const max = o.maxBytes ?? 2_000_000;
    const reader = r.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); break; } chunks.push(value); }
    const text = Buffer.concat(chunks).toString('utf8');
    const ct = r.headers.get('content-type') ?? '';
    const isHtml = /html/i.test(ct) || /^\s*<(!doctype|html)/i.test(text);
    const markdown = isHtml ? htmlToMarkdown(text) : /json/i.test(ct) ? '```json\n' + text + '\n```' : text;
    const title = /^# (.+)$/m.exec(markdown)?.[1] ?? u.hostname + u.pathname;
    return { url, finalUrl: r.url || url, title, markdown, fetchedAt: new Date().toISOString(), status: r.status, contentType: ct, etag: r.headers.get('etag') ?? undefined };
  } finally {
    clearTimeout(timer);
  }
}

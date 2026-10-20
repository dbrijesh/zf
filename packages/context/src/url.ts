import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { invalid } from '@zerovity/core';
import { htmlToMarkdown } from './convert';

export interface Snapshot { url: string; finalUrl: string; title: string; markdown: string; fetchedAt: string; status: number; contentType: string; etag?: string }

/** IPv6 text -> 16 bytes (handles :: compression and an embedded dotted IPv4 tail), or undefined when it is not valid IPv6. */
function ipv6Bytes(ip: string): number[] | undefined {
  if (!net.isIPv6(ip)) return undefined;
  let s = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) { const o = dotted[1].split('.').map(Number); s = s.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16); }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return undefined;
  return groups.flatMap((g) => [g >> 8, g & 255]);
}

/** Block loopback, link-local, private, carrier-grade NAT, benchmarking, multicast and reserved ranges so a URL context item cannot be used for SSRF. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ipv6Bytes(ip);
  if (!v6) return true; // anything that is not a valid address is refused
  const allZero = (from: number, to: number) => v6.slice(from, to).every((x) => x === 0);
  if (allZero(0, 15) && (v6[15] === 0 || v6[15] === 1)) return true; // :: and ::1
  if (allZero(0, 10) && v6[10] === 0xff && v6[11] === 0xff) return isPrivateIp(v6.slice(12).join('.')); // ::ffff:a.b.c.d (any spelling)
  if (allZero(0, 12)) return isPrivateIp(v6.slice(12).join('.')); // IPv4-compatible ::a.b.c.d
  if (v6[0] === 0 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b) return isPrivateIp(v6.slice(12).join('.')); // NAT64 64:ff9b::/96
  return (v6[0] & 0xfe) === 0xfc /* fc00::/7 */ || (v6[0] === 0xfe && (v6[1] & 0xc0) >= 0x80) /* fe80::/10 and fec0::/10 */ || v6[0] === 0xff /* multicast */;
}

export interface FetchOptions { allowPrivate?: boolean; maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch; headers?: Record<string, string>; lookup?: (host: string) => Promise<string[]>; maxRedirects?: number }

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

interface Raw { status: number; headers: (name: string) => string | null; url: string; body: Buffer }

/** Read a response body up to a byte cap. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer> {
  const reader = stream?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); break; } chunks.push(value); }
  return Buffer.concat(chunks);
}

/**
 * One request to a validated address. The connection goes to the IP that passed the private-range check (SNI and the Host
 * header keep the real name), so DNS cannot change its answer between the check and the connect (DNS rebinding).
 */
function pinnedGet(u: URL, ip: string, o: FetchOptions, signal: AbortSignal): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const max = o.maxBytes ?? 2_000_000;
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: ip, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', servername: net.isIP(u.hostname) ? undefined : u.hostname, signal,
      headers: { host: u.host, 'user-agent': 'ZerovityFactory/0.1 (+context snapshot)', accept: 'text/html,text/markdown,text/plain,application/json;q=0.9', 'accept-encoding': 'identity', ...o.headers },
    }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (d: Buffer) => { size += d.length; if (size > max) { res.destroy(); return; } chunks.push(d); });
      const done = () => resolve({ status: res.statusCode ?? 0, headers: (n) => { const v = res.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; }, url: u.toString(), body: Buffer.concat(chunks) });
      res.on('end', done); res.on('close', done); res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** exported for tests */
export const _pinnedGet = pinnedGet;

async function resolvePublic(u: URL, o: FetchOptions): Promise<string | undefined> {
  if (o.allowPrivate) return undefined;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : await (o.lookup ?? (async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address)))(host);
  if (!addrs.length || addrs.some(isPrivateIp)) throw invalid(`Refusing to fetch ${u.hostname}: address is private or unresolved`);
  return addrs[0];
}

/**
 * Fetch a page as markdown. Every hop of a redirect chain is checked again (a public page can redirect to
 * http://169.254.169.254/), and with the default transport the connection is pinned to the checked address.
 */
export async function fetchSnapshot(url: string, o: FetchOptions = {}): Promise<Snapshot> {
  const first = new URL(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
  try {
    let u = first;
    let raw: Raw | undefined;
    for (let hop = 0; hop <= (o.maxRedirects ?? 5); hop++) {
      if (!/^https?:$/.test(u.protocol)) throw invalid('Only http and https URLs can be attached');
      const ip = await resolvePublic(u, o);
      if (o.fetchImpl || !ip) {
        const r = await (o.fetchImpl ?? fetch)(u.toString(), { signal: ctl.signal, redirect: 'manual', headers: { 'user-agent': 'ZerovityFactory/0.1 (+context snapshot)', accept: 'text/html,text/markdown,text/plain,application/json;q=0.9', ...o.headers } });
        raw = { status: r.status, headers: (n) => r.headers.get(n), url: r.url || u.toString(), body: await readCapped(r.body, o.maxBytes ?? 2_000_000) };
      } else raw = await pinnedGet(u, ip, o, ctl.signal);
      const loc = raw.headers('location');
      if (REDIRECTS.has(raw.status) && loc) { u = new URL(loc, u); raw = undefined; continue; }
      break;
    }
    if (!raw) throw invalid('Too many redirects');
    const text = raw.body.toString('utf8');
    const ct = raw.headers('content-type') ?? '';
    const isHtml = /html/i.test(ct) || /^\s*<(!doctype|html)/i.test(text);
    const markdown = isHtml ? htmlToMarkdown(text) : /json/i.test(ct) ? '```json\n' + text + '\n```' : text;
    const title = /^# (.+)$/m.exec(markdown)?.[1] ?? first.hostname + first.pathname;
    return { url, finalUrl: u.toString(), title, markdown, fetchedAt: new Date().toISOString(), status: raw.status, contentType: ct, etag: raw.headers('etag') ?? undefined };
  } finally {
    clearTimeout(timer);
  }
}

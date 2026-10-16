import type { NormalisedEvent, Usage } from '@zerovity/core';
import { emptyUsage } from '@zerovity/core';
import { spawnSync } from 'node:child_process';

/** Try several argument styles to detect a CLI and its version without throwing. */
export function detectCli(cmd: string, versionArgs: string[] = ['--version']): { installed: boolean; version?: string } {
  try {
    let r = spawnSync(cmd, versionArgs, { encoding: 'utf8', timeout: 8000 });
    // npm-installed CLIs on Windows are .cmd shims that need cmd.exe (arguments here are fixed strings, never user input)
    if (r.error && process.platform === 'win32') r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [cmd, ...versionArgs].join(' ')], { encoding: 'utf8', timeout: 8000 });
    if (r.error || r.status === null || (r.status !== 0 && !r.stdout)) return { installed: false };
    const v = /(\d+\.\d+\.\d+[\w.-]*)/.exec(`${r.stdout} ${r.stderr}`);
    return { installed: r.status === 0, version: v?.[1] };
  } catch {
    return { installed: false };
  }
}

export function sumUsage(events: NormalisedEvent[]): Usage {
  const u = emptyUsage();
  let cost: number | undefined;
  let premium: number | undefined;
  for (const e of events) {
    if (e.kind !== 'usage') continue;
    u.inputTokens += e.inputTokens;
    u.outputTokens += e.outputTokens;
    u.cachedTokens += e.cachedTokens ?? 0;
    if (e.costUsd !== undefined) cost = (cost ?? 0) + e.costUsd;
    if (e.premiumRequests !== undefined) premium = (premium ?? 0) + e.premiumRequests;
  }
  if (cost !== undefined) u.costUsd = cost;
  if (premium !== undefined) u.premiumRequests = premium;
  return u;
}

export function firstSession(events: NormalisedEvent[]): string | undefined {
  for (const e of events) if (e.kind === 'session.started') return e.sessionId;
  return undefined;
}

export function safeJson(line: string): Record<string, unknown> | undefined {
  const t = line.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** make an absolute path relative to cwd with forward slashes when it lies under it */
export function relPath(p: string, cwd?: string): string {
  const n = p.replace(/\\/g, '/');
  if (!cwd) return n;
  const c = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  return n.toLowerCase().startsWith(c.toLowerCase() + '/') ? n.slice(c.length + 1) : n;
}

export function str(v: unknown, max = 600): string {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/** quote for the model prompt only: collapse nothing, but guard against NULs */
export const cleanPrompt = (s: string): string => s.replace(/\u0000/g, '');

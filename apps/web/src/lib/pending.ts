/** Tool calls that have started but not returned a result yet, derived from the normalised run events (harness neutral). */
export interface PendingEv { seq: number; ts: string; kind: string; [k: string]: unknown }
export interface PendingCall { id: string; tool: string; label: string; since: string }

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A short human label: the command for shell tools, otherwise the tool name and its most telling argument. */
export function describeCall(tool: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const cmd = i.command ?? i.cmd;
  if (typeof cmd === 'string') return clip(cmd.replace(/\s+/g, ' ').trim());
  const arg = i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description;
  return typeof arg === 'string' ? `${tool} ${clip(arg, 100)}` : tool;
}

/** Calls with no matching tool.result, oldest first. Calls without an id cannot be matched, so they are ignored. */
export function pendingCalls(events: PendingEv[]): PendingCall[] {
  const open = new Map<string, PendingCall>();
  for (const e of events) {
    const id = typeof e.id === 'string' ? e.id : undefined;
    if (!id) continue;
    if (e.kind === 'tool.call') open.set(id, { id, tool: String(e.tool ?? 'tool'), label: describeCall(String(e.tool ?? 'tool'), e.input), since: e.ts });
    else if (e.kind === 'tool.result') open.delete(id);
  }
  return [...open.values()];
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

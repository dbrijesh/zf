import { QueryClient, useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect } from 'react';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

type Q = Record<string, string | number | boolean | undefined | null>;
const qs = (q?: Q) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };

export async function api<T = unknown>(path: string, o: { method?: string; body?: unknown; query?: Q; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const r = await fetch(`/api/v1${path}${qs(o.query)}`, {
    method: o.method ?? (o.body || o.form ? 'POST' : 'GET'), credentials: 'include', signal: o.signal,
    headers: o.body !== undefined ? { 'content-type': 'application/json' } : undefined, body: o.form ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  const text = await r.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
  if (!r.ok) {
    const j = (json ?? {}) as { error?: string; message?: string; details?: unknown };
    if (r.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('zf-unauthorized'));
    throw new ApiError(r.status, j.error ?? 'error', j.message ?? r.statusText, j.details);
  }
  return json as T;
}

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 4_000, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: true } } });

/* ---------------- types (the parts the UI relies on) ---------------- */
export interface Me { id: string; email: string; name: string; role: string; orgId: string; groups: string[]; factories: Array<{ id: string; name: string; role: string }> }
export interface FloorItem { id: string; shortId: string; title: string; source: string; state: string; lane: string; status: 'run' | 'ask' | 'gate' | 'loop' | 'blocked' | 'handoff' | 'queued'; agent: string | null; harness: string | null; model: string | null; elapsedMin: number; costUsd: number; budgetUsd: number | null; budgetUsed: number; loops: number; maxLoops: number; liveRunId: string | null; lastEvent: string | null; since: string; pausedFor: string | null; prUrl: string | null }
export interface Floor {
  items: FloorItem[]; lanes: Array<{ lane: string; agent?: string; harness?: string; count: number }>;
  counters: { activeRuns: number; waiting: number; completedToday: number; completedDelta: number; spendToday: number };
  mix: Array<{ harness: string; costUsd: number; premiumRequests: number; tokens: number }>; medians: Array<{ phase: string; minutes: number }>;
  recentEvents: Array<{ ts: string; agent: string; text: string; phase: string; workItem: string }>; rev: number;
  factory: { id: string; name: string; paused: boolean }; health: Array<{ label: string; state: 'ok' | 'warn' | 'none'; detail: string }>;
}
export interface InboxItem { id: string; kind: string; status: string; read: boolean; title: string; body: string; workItemId: string | null; factoryId: string | null; payload: Record<string, unknown>; createdAt: string; refKey: string | null }
export interface WorkItem { id: string; factoryId: string; shortId: string; title: string; body: string; state: string; phase: string | null; sourceType: string; sourceRef: string | null; sourceUrl: string | null; costUsd: number; budgetUsd: number | null; loops: number; branch: string | null; prUrl: string | null; prNumber: number | null; tokensIn: number; tokensOut: number; createdAt: string; stateSince: string; pausedState: string | null; gate: string | null; flags: Record<string, unknown>; triage: Record<string, unknown> | null }
export interface Run { id: string; workItemId: string; factoryId: string; agentName: string; phase: string; harness: string; model: string | null; sessionId: string | null; status: string; kind: string; attempt: number; startedAt: string | null; endedAt: string | null; exitReason: string | null; contextBundleHash: string | null; tokensIn: number; tokensOut: number; tokensCached: number; costUsd: number; premiumRequests: number | null; eventCount: number; createdAt: string; resultJson: RunResultJson | null; shortId?: string; title?: string }
export interface RunResultJson { status: string; summary: string; questions: Array<{ id: string; text: string; options?: string[] }>; artifacts: Array<{ path: string; type?: string }>; evidence: Array<{ type: string; command?: string; exitCode?: number; logPath?: string }>; recommendation?: string; findings: Array<{ severity: string; file?: string; line?: number; text: string }> }
export interface Question { id: string; workItemId: string; qid: string; kind: 'decision' | 'context_request'; text: string; options: string[] | null; why: string | null; askedBy: string | null; answer: string | null; answeredBy: string | null; answeredAt: string | null }
export interface Gate { id: string; workItemId: string; type: string; status: string; subjectHash: string | null; requestedAt: string; decidedBy: string | null; decidedAt: string | null; reason: string | null; comments: Array<{ file?: string; line?: number; text: string }> }
export interface Message { id: string; authorKind: string; authorName: string | null; body: string; channel: string; createdAt: string; meta: Record<string, unknown> }
export type TimelineEntry = ({ kind: 'run'; at: string; endedAt: string | null; runId: string; agent: string; harness: string; model: string | null; phase: string; status: string; durationMin: number; tokens: number; costUsd: number; attempt: number; summary: string | null }) | ({ kind: 'gate'; at: string; endedAt: string | null; gateId: string; gate: string; status: string; decidedBy: string | null; reason: string | null; subjectHash: string | null });
export interface ItemDetail { workItem: WorkItem; factory: { id: string; name: string; orgId: string; alias: string | null }; repo?: { owner: string; name: string; defaultBranch: string }; runs: Run[]; gates: Gate[]; questions: Question[]; messages: Message[]; timeline: TimelineEntry[]; pendingGate: Gate | null; audit: { entries: AuditEntry[]; verified: { ok: boolean; checked: number; brokenAt?: number; reason?: string } }; phases: Array<{ name: string; phase: string }>; maxLoops: number }
export interface AuditEntry { id: string; seq: number; actor: string; action: string; subject: string; payload: unknown; payloadHash: string; prevHash: string; hash: string; ts: string }
export interface CtxReportLine { id: string; title: string; layer: string; kind: string; priority: string; tokens: number; form: 'full' | 'index' | 'dropped'; reason?: string }
export interface CtxPreview { agent: string; phase: string; contextMd: string; items: Record<string, string>; report: CtxReportLine[]; tokens: number; budget: number; trimmed: boolean; bundleHash: string }
export interface Issue { severity: 'error' | 'warning' | 'info'; code: string; message: string; file: string; line?: number; col?: number }
export interface ContextItem { id: string; layer: string; scopeId: string; kind: string; title: string; body: string; summary: string; tags: string[]; priority: string; tokenCount: number; version: number; enabled: boolean; appliesTo: { phases: string[]; agents: string[] }; meta: Record<string, unknown>; updatedAt: string; createdBy: string | null }
export interface AgentView { name: string; source: string; description: string; phase: string; role: string | null; harness: { type: string; model?: string; reasoning?: string }; effectiveHarness: string; forced: boolean; runner: string; contextScopes: string[]; outputs: string[]; mcpServers: string[]; credential: string | null; secrets: string[]; maxRunMinutes: number | null; body: string; bodyLines: number; skills: Array<{ name: string; layer: string; source: string; overrides: string[]; description: string; tokens: { body: number; description: number; total: number } }>; missingSkills: string[]; weight: { body: number; skillDescriptions: number; total: number; onDemand: number }; overridden: string[]; stats: { runs: number; success: number; successRate: number; avgCostUsd: number; avgMinutes: number; avgTokens: number } | null }
export interface ConnType { id: string; type: string; provider: string; title: string; group: string; description: string; v1: boolean; authKind: string; flow?: string; fields: Array<{ name: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string; kind?: string }> }
export interface Connection { id: string; typeId: string; type: string; provider: string; displayName: string; authKind: string; status: string; scopes: string[]; config: Record<string, unknown>; secrets: Array<{ name: string; last4: string }>; lastCheckedAt: string | null; lastError: string | null; expiresAt: string | null; createdBy: string | null; createdAt: string; dependents?: { factories: Array<{ id: string; name: string }>; agents: Array<{ factory: string; agent: string }>; automations: Array<{ factory: string; automation: string }> } }

/* ---------------- hooks ---------------- */
export function useApi<T>(key: unknown[], path: string | null, query?: Q, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: [...key, query], queryFn: ({ signal }) => api<T>(path!, { query, signal }), enabled: path !== null && (opts.enabled ?? true), ...opts } as UseQueryOptions<T>);
}
export function useAct<A, R = unknown>(fn: (a: A) => Promise<R>, o: { invalidate?: unknown[][]; onSuccess?: (r: R, a: A) => void; onError?: (e: Error) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<R, Error, A>({ mutationFn: fn, onSuccess: (r, a) => { for (const k of o.invalidate ?? [[]]) void qc.invalidateQueries({ queryKey: k }); o.onSuccess?.(r, a); }, onError: o.onError });
}

/** Subscribe to the factory event stream; every revision bump refetches active queries (throttled). */
export function useLiveInvalidation(factoryId: string | undefined) {
  useEffect(() => {
    if (!factoryId) return;
    let es: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const fire = () => { if (timer) return; timer = setTimeout(() => { timer = undefined; void queryClient.invalidateQueries({ refetchType: 'active', predicate: (q) => q.queryKey[0] !== 'static' }); }, 200); };
    const connect = () => {
      es = new EventSource(`/api/v1/events?factoryId=${factoryId}`, { withCredentials: true });
      es.addEventListener('rev', fire);
      es.onerror = () => { es?.close(); if (!closed) setTimeout(connect, 3000); };
    };
    connect();
    return () => { closed = true; es?.close(); if (timer) clearTimeout(timer); };
  }, [factoryId]);
}

export const downloadUrl = (path: string, q?: Q) => `/api/v1${path}${qs(q)}`;

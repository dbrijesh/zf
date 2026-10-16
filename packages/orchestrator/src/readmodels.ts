import { and, asc, desc, eq, gte, inArray, lte, sql, isNull } from 'drizzle-orm';
import { median, laneOf, notFound, type WorkState, type Lane, type TokenStatus, type RunResult } from '@zerovity/core';
import { tables as t, readChain, verifyAudit, type Db } from '@zerovity/db';
import type { DefinitionService } from './definitions';

export interface FloorItem {
  id: string; shortId: string; title: string; source: string; state: string; lane: Lane; status: TokenStatus; agent: string | null; harness: string | null; model: string | null;
  elapsedMin: number; costUsd: number; budgetUsd: number | null; budgetUsed: number; loops: number; maxLoops: number; liveRunId: string | null; lastEvent: string | null; since: string; pausedFor: string | null; prUrl: string | null;
}
export interface FloorLane { lane: Lane; agent?: string; harness?: string; count: number }
export interface FloorView {
  items: FloorItem[];
  lanes: FloorLane[];
  counters: { activeRuns: number; waiting: number; completedToday: number; completedDelta: number; spendToday: number };
  mix: Array<{ harness: string; costUsd: number; premiumRequests: number; tokens: number }>;
  medians: Array<{ phase: string; minutes: number }>;
  recentEvents: Array<{ ts: string; agent: string; text: string; phase: string; workItem: string }>;
  rev: number;
}

const LANES: Lane[] = ['INTENT', 'SPEC', 'GATE', 'BUILD', 'VERIFY', 'SHIP'];
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const mins = (a?: Date | null, b?: Date | null) => (a && b ? Math.max(0, (b.getTime() - a.getTime()) / 60000) : 0);

export async function floorView(db: Db, defs: DefinitionService, factoryId: string, opts: { now?: Date; sinceDays?: number } = {}): Promise<FloorView> {
  const now = opts.now ?? new Date();
  const active = await defs.getActive(factoryId);
  const items = await db.select().from(t.workItems).where(and(eq(t.workItems.factoryId, factoryId), inArray(t.workItems.state, ['INTAKE', 'INTENT', 'SPEC', 'AWAITING_SPEC_APPROVAL', 'BUILD', 'VERIFY', 'AWAITING_GATE', 'SHIP', 'AWAITING_HANDOFF', 'NEEDS_INPUT', 'BLOCKED'])));
  const ids = items.map((i) => i.id);
  const liveRuns = ids.length ? await db.select().from(t.runs).where(and(inArray(t.runs.workItemId, ids), inArray(t.runs.status, ['queued', 'running']))) : [];
  const lastRuns = ids.length ? await db.select().from(t.runs).where(inArray(t.runs.workItemId, ids)).orderBy(desc(t.runs.createdAt)) : [];
  const lastEv = new Map<string, string>();
  for (const r of liveRuns) {
    const [e] = await db.select().from(t.runEvents).where(and(eq(t.runEvents.runId, r.id), inArray(t.runEvents.kind, ['message.assistant', 'command.run', 'file.changed', 'tool.call']))).orderBy(desc(t.runEvents.seq)).limit(1);
    if (e) lastEv.set(r.workItemId, describeEvent(e.kind, e.payload));
  }
  const out: FloorItem[] = items.map((w) => {
    const lane = laneOf(w.state as WorkState, w.pausedState) ?? 'INTENT';
    const live = liveRuns.find((r) => r.workItemId === w.id);
    const last = lastRuns.find((r) => r.workItemId === w.id);
    const maxLoops = active?.policy.maxRevisionLoops ?? 3;
    let status: TokenStatus = 'run';
    if (w.state === 'NEEDS_INPUT') status = 'ask';
    else if (lane === 'GATE') status = 'gate';
    else if (w.state === 'BLOCKED') status = 'blocked';
    else if (w.state === 'AWAITING_HANDOFF') status = 'handoff';
    else if (w.loops > 0 && (w.state === 'BUILD' || w.state === 'VERIFY')) status = 'loop';
    else if (live?.status === 'queued') status = 'queued';
    return {
      id: w.id, shortId: w.shortId, title: w.title, source: w.sourceType, state: w.state, lane, status, agent: (live ?? last)?.agentName ?? null, harness: (live ?? last)?.harness ?? null, model: (live ?? last)?.model ?? null,
      elapsedMin: Math.round(mins(w.createdAt, now)), costUsd: w.costUsd, budgetUsd: w.budgetUsd, budgetUsed: w.budgetUsd ? Math.min(1, w.costUsd / w.budgetUsd) : 0, loops: w.loops, maxLoops, liveRunId: live?.id ?? null,
      lastEvent: lastEv.get(w.id) ?? null, since: w.stateSince.toISOString(), pausedFor: w.state === 'NEEDS_INPUT' ? w.pausedState : null, prUrl: w.prUrl,
    };
  });
  const lanes: FloorLane[] = LANES.map((lane) => {
    const a = lane === 'GATE' ? undefined : [...(active?.agents.values() ?? [])].filter((x) => x.fm.phase === lane)[0];
    const h = a && active ? defs.effectiveHarness(active, a) : undefined;
    return { lane, agent: a?.name, harness: h?.type, count: out.filter((i) => i.lane === lane).length };
  });
  const today = startOfDay(now);
  const yesterday = new Date(today.getTime() - 86_400_000);
  const done = await db.select().from(t.workItems).where(and(eq(t.workItems.factoryId, factoryId), eq(t.workItems.state, 'COMPLETE'), gte(t.workItems.completedAt, yesterday)));
  const doneToday = done.filter((d) => d.completedAt && d.completedAt >= today).length;
  const runsToday = await db.select().from(t.runs).where(and(eq(t.runs.factoryId, factoryId), gte(t.runs.createdAt, today)));
  const mixMap = new Map<string, { harness: string; costUsd: number; premiumRequests: number; tokens: number }>();
  for (const r of runsToday) {
    const m = mixMap.get(r.harness) ?? { harness: r.harness, costUsd: 0, premiumRequests: 0, tokens: 0 };
    m.costUsd += r.costUsd; m.premiumRequests += r.premiumRequests ?? 0; m.tokens += r.tokensIn + r.tokensOut;
    mixMap.set(r.harness, m);
  }
  const week = await db.select().from(t.runs).where(and(eq(t.runs.factoryId, factoryId), gte(t.runs.createdAt, new Date(now.getTime() - (opts.sinceDays ?? 7) * 86_400_000)), eq(t.runs.status, 'done')));
  const byPhase = new Map<string, number[]>();
  for (const r of week) byPhase.set(r.phase, [...(byPhase.get(r.phase) ?? []), mins(r.startedAt, r.endedAt)]);
  const evs = await db.select({ e: t.runEvents, r: t.runs }).from(t.runEvents).innerJoin(t.runs, eq(t.runEvents.runId, t.runs.id)).where(and(eq(t.runs.factoryId, factoryId), inArray(t.runEvents.kind, ['message.assistant', 'command.run', 'file.changed']))).orderBy(desc(t.runEvents.id)).limit(14);
  const wiMap = new Map(items.map((i) => [i.id, i.shortId]));
  const rev = Number((await db.select().from(t.kv).where(eq(t.kv.key, `rev:${factoryId}`)))[0]?.value ?? 0);
  return {
    items: out, lanes,
    counters: { activeRuns: liveRuns.filter((r) => r.status === 'running').length, waiting: out.filter((i) => i.status === 'ask' || i.status === 'gate' || i.status === 'handoff' || i.status === 'blocked').length, completedToday: doneToday, completedDelta: doneToday - (done.length - doneToday), spendToday: runsToday.reduce((a, r) => a + r.costUsd, 0) },
    mix: [...mixMap.values()],
    medians: ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'].map((p) => ({ phase: p, minutes: Math.round(median(byPhase.get(p) ?? []) * 10) / 10 })),
    recentEvents: evs.map((x) => ({ ts: x.e.ts.toISOString(), agent: x.r.agentName, phase: x.r.phase, workItem: wiMap.get(x.r.workItemId) ?? '', text: describeEvent(x.e.kind, x.e.payload) })),
    rev,
  };
}

export function describeEvent(kind: string, p: Record<string, unknown>): string {
  switch (kind) {
    case 'message.assistant': return String(p.text ?? '').split('\n')[0].slice(0, 160);
    case 'command.run': return `ran ${String(p.command ?? '').slice(0, 100)}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ''}`;
    case 'file.changed': return `${p.op === 'add' ? 'added' : p.op === 'delete' ? 'deleted' : 'edited'} ${p.path}`;
    case 'tool.call': return `using ${p.tool}`;
    case 'error': return `error: ${String(p.message ?? '').slice(0, 120)}`;
    default: return kind;
  }
}

/* ----------------------------------------------------------------------------------------------- work items */

export async function listWorkItems(db: Db, f: { factoryId?: string; orgId?: string; state?: string[]; q?: string; limit?: number; offset?: number; source?: string }) {
  const conds = [];
  if (f.factoryId) conds.push(eq(t.workItems.factoryId, f.factoryId));
  if (f.state?.length) conds.push(inArray(t.workItems.state, f.state));
  if (f.source) conds.push(eq(t.workItems.sourceType, f.source));
  if (f.q) conds.push(sql`(${t.workItems.title} ilike ${'%' + f.q + '%'} or ${t.workItems.shortId} ilike ${'%' + f.q + '%'} or ${t.workItems.body} ilike ${'%' + f.q + '%'})`);
  const rows = await db.select().from(t.workItems).where(conds.length ? and(...conds) : undefined).orderBy(desc(t.workItems.createdAt)).limit(f.limit ?? 100).offset(f.offset ?? 0);
  return rows;
}

export async function workItemDetail(db: Db, defs: DefinitionService, id: string) {
  const [w] = await db.select().from(t.workItems).where(eq(t.workItems.id, id));
  if (!w) throw notFound('Work item', id);
  const [factory] = await db.select().from(t.factories).where(eq(t.factories.id, w.factoryId));
  const repo = w.repoId ? (await db.select().from(t.repositories).where(eq(t.repositories.id, w.repoId)))[0] : undefined;
  const runs = await db.select().from(t.runs).where(eq(t.runs.workItemId, id)).orderBy(asc(t.runs.createdAt));
  const gates = await db.select().from(t.gates).where(eq(t.gates.workItemId, id)).orderBy(asc(t.gates.requestedAt));
  const questions = await db.select().from(t.questions).where(eq(t.questions.workItemId, id)).orderBy(asc(t.questions.createdAt));
  const messages = await db.select().from(t.messages).where(eq(t.messages.workItemId, id)).orderBy(asc(t.messages.createdAt));
  const active = await defs.getActive(w.factoryId);
  const chain = await readChain(db, w.factoryId);
  const mine = chain.filter((e) => e.subject === w.shortId || (e.payload as { runId?: string } | null)?.runId && runs.some((r) => r.id === (e.payload as { runId: string }).runId));
  const audit = await verifyAudit(db, w.factoryId);
  const timeline = [
    ...runs.map((r) => ({ kind: 'run' as const, at: (r.startedAt ?? r.createdAt).toISOString(), endedAt: r.endedAt?.toISOString() ?? null, runId: r.id, agent: r.agentName, harness: r.harness, model: r.model, phase: r.phase, status: r.status, durationMin: Math.round(mins(r.startedAt, r.endedAt ?? undefined) * 10) / 10, tokens: r.tokensIn + r.tokensOut, costUsd: r.costUsd, attempt: r.attempt, summary: (r.resultJson as RunResult | null)?.summary ?? null })),
    ...gates.map((g) => ({ kind: 'gate' as const, at: g.requestedAt.toISOString(), endedAt: g.decidedAt?.toISOString() ?? null, gateId: g.id, gate: g.type, status: g.status, decidedBy: g.decidedBy, reason: g.reason, subjectHash: g.subjectHash })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    workItem: w, factory: { id: factory.id, name: factory.name, orgId: factory.orgId, alias: factory.alias }, repo, runs, gates, questions, messages, timeline,
    pendingGate: gates.find((g) => g.status === 'pending') ?? null, audit: { entries: mine.slice(-200), verified: audit },
    phases: [...(active?.agents.values() ?? [])].map((a) => ({ name: a.name, phase: a.fm.phase })), maxLoops: active?.policy.maxRevisionLoops ?? 3,
  };
}

export async function runDetail(db: Db, id: string) {
  const [run] = await db.select().from(t.runs).where(eq(t.runs.id, id));
  if (!run) throw notFound('Run', id);
  const [w] = await db.select().from(t.workItems).where(eq(t.workItems.id, run.workItemId));
  return { run, workItem: w };
}

export async function runEventsAfter(db: Db, runId: string, afterSeq = 0, limit = 500) {
  return db.select().from(t.runEvents).where(and(eq(t.runEvents.runId, runId), sql`${t.runEvents.seq} > ${afterSeq}`)).orderBy(asc(t.runEvents.seq)).limit(limit);
}

export async function listRuns(db: Db, f: { factoryId: string; status?: string[]; limit?: number }) {
  const rows = await db.select({ run: t.runs, w: { shortId: t.workItems.shortId, title: t.workItems.title } }).from(t.runs).innerJoin(t.workItems, eq(t.runs.workItemId, t.workItems.id)).where(and(eq(t.runs.factoryId, f.factoryId), f.status?.length ? inArray(t.runs.status, f.status) : undefined)).orderBy(desc(t.runs.createdAt)).limit(f.limit ?? 100);
  return rows.map((r) => ({ ...r.run, shortId: r.w.shortId, title: r.w.title }));
}

/* ----------------------------------------------------------------------------------------------- stats */

export async function agentStats(db: Db, factoryId: string): Promise<Record<string, { runs: number; success: number; successRate: number; avgCostUsd: number; avgMinutes: number; avgTokens: number }>> {
  const runs = await db.select().from(t.runs).where(and(eq(t.runs.factoryId, factoryId), inArray(t.runs.status, ['done', 'failed', 'needs_input', 'blocked', 'timeout'])));
  const by = new Map<string, typeof runs>();
  for (const r of runs) by.set(r.agentName, [...(by.get(r.agentName) ?? []), r]);
  const out: Record<string, { runs: number; success: number; successRate: number; avgCostUsd: number; avgMinutes: number; avgTokens: number }> = {};
  for (const [a, rs] of by) {
    const ok = rs.filter((r) => r.status === 'done' || r.status === 'needs_input').length;
    out[a] = { runs: rs.length, success: ok, successRate: rs.length ? ok / rs.length : 0, avgCostUsd: rs.reduce((x, r) => x + r.costUsd, 0) / rs.length, avgMinutes: rs.reduce((x, r) => x + mins(r.startedAt, r.endedAt), 0) / rs.length, avgTokens: rs.reduce((x, r) => x + r.tokensIn + r.tokensOut, 0) / rs.length };
  }
  return out;
}

export interface DashboardView {
  range: { from: string; to: string };
  completed: number; autonomyRate: number | null; cycleTimeByPhase: Array<{ phase: string; medianMin: number; p90Min: number; n: number }>; costPerCompleted: number | null; totalCost: number;
  tokensByHarness: Array<{ harness: string; model: string; tokensIn: number; tokensOut: number; tokensCached: number; costUsd: number; runs: number }>;
  gateWaitMedianMin: number; gateWaitByGate: Array<{ gate: string; medianMin: number; n: number }>; revisionLoopsPerItem: number; revisionHistogram: Record<string, number>;
  scorerPassRates: Array<{ scorer: string; total: number; pass: number; rate: number }>; daily: Array<{ day: string; completed: number; costUsd: number; runs: number }>; funnel: Array<{ state: string; n: number }>;
  failureRate: number;
}

export async function dashboardView(db: Db, factoryId: string, from: Date, to: Date): Promise<DashboardView> {
  const items = await db.select().from(t.workItems).where(and(eq(t.workItems.factoryId, factoryId), lte(t.workItems.createdAt, to)));
  const completed = items.filter((i) => i.state === 'COMPLETE' && i.completedAt && i.completedAt >= from && i.completedAt <= to);
  const runs = await db.select().from(t.runs).where(and(eq(t.runs.factoryId, factoryId), gte(t.runs.createdAt, from), lte(t.runs.createdAt, to)));
  const finished = runs.filter((r) => ['done', 'failed', 'needs_input', 'blocked', 'timeout'].includes(r.status));
  const byPhase = new Map<string, number[]>();
  for (const r of runs.filter((x) => x.status === 'done')) byPhase.set(r.phase, [...(byPhase.get(r.phase) ?? []), mins(r.startedAt, r.endedAt)]);
  const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))] : 0);
  const th = new Map<string, { harness: string; model: string; tokensIn: number; tokensOut: number; tokensCached: number; costUsd: number; runs: number }>();
  for (const r of runs) {
    const k = `${r.harness}|${r.model ?? ''}`;
    const e = th.get(k) ?? { harness: r.harness, model: r.model ?? '', tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, runs: 0 };
    e.tokensIn += r.tokensIn; e.tokensOut += r.tokensOut; e.tokensCached += r.tokensCached; e.costUsd += r.costUsd; e.runs++;
    th.set(k, e);
  }
  const itemIds = items.map((i) => i.id);
  const gates = itemIds.length ? await db.select().from(t.gates).where(and(inArray(t.gates.workItemId, itemIds), gte(t.gates.requestedAt, from), lte(t.gates.requestedAt, to))) : [];
  const decided = gates.filter((g) => g.decidedAt);
  const gw = new Map<string, number[]>();
  for (const g of decided) gw.set(g.type, [...(gw.get(g.type) ?? []), mins(g.requestedAt, g.decidedAt)]);
  const hist: Record<string, number> = {};
  for (const c of completed) hist[String(c.loops)] = (hist[String(c.loops)] ?? 0) + 1;
  const scorers = await db.select().from(t.scorers).where(eq(t.scorers.factoryId, factoryId));
  const scores = scorers.length ? await db.select().from(t.scores).where(and(inArray(t.scores.scorerId, scorers.map((s) => s.id)), gte(t.scores.createdAt, from), lte(t.scores.createdAt, to))) : [];
  const days = new Map<string, { day: string; completed: number; costUsd: number; runs: number }>();
  for (let d = startOfDay(from); d <= to; d = new Date(d.getTime() + 86_400_000)) days.set(d.toISOString().slice(0, 10), { day: d.toISOString().slice(0, 10), completed: 0, costUsd: 0, runs: 0 });
  for (const c of completed) { const e = days.get(c.completedAt!.toISOString().slice(0, 10)); if (e) e.completed++; }
  for (const r of runs) { const e = days.get(r.createdAt.toISOString().slice(0, 10)); if (e) { e.costUsd += r.costUsd; e.runs++; } }
  const autonomous = completed.filter((c) => !(c.flags as { humanCommits?: boolean }).humanCommits);
  const funnelStates = ['INTAKE', 'INTENT', 'SPEC', 'AWAITING_SPEC_APPROVAL', 'BUILD', 'VERIFY', 'SHIP', 'AWAITING_HANDOFF', 'NEEDS_INPUT', 'BLOCKED', 'COMPLETE', 'CANCELLED', 'FAILED'];
  const totalCost = runs.reduce((a, r) => a + r.costUsd, 0);
  return {
    range: { from: from.toISOString(), to: to.toISOString() }, completed: completed.length, autonomyRate: completed.length ? autonomous.length / completed.length : null,
    cycleTimeByPhase: ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'].map((p) => ({ phase: p, medianMin: Math.round(median(byPhase.get(p) ?? []) * 10) / 10, p90Min: Math.round(p90(byPhase.get(p) ?? []) * 10) / 10, n: (byPhase.get(p) ?? []).length })),
    costPerCompleted: completed.length ? completed.reduce((a, c) => a + c.costUsd, 0) / completed.length : null, totalCost,
    tokensByHarness: [...th.values()].sort((a, b) => b.costUsd - a.costUsd),
    gateWaitMedianMin: Math.round(median(decided.map((g) => mins(g.requestedAt, g.decidedAt))) * 10) / 10, gateWaitByGate: [...gw].map(([gate, xs]) => ({ gate, medianMin: Math.round(median(xs) * 10) / 10, n: xs.length })),
    revisionLoopsPerItem: completed.length ? completed.reduce((a, c) => a + c.loops, 0) / completed.length : 0, revisionHistogram: hist,
    scorerPassRates: scorers.map((s) => { const mine = scores.filter((x) => x.scorerId === s.id); const pass = mine.filter((m) => s.passLabels.includes(m.label)).length; return { scorer: s.name, total: mine.length, pass, rate: mine.length ? pass / mine.length : 0 }; }),
    daily: [...days.values()], funnel: funnelStates.map((s) => ({ state: s, n: items.filter((i) => i.state === s).length })).filter((x) => x.n),
    failureRate: finished.length ? finished.filter((r) => r.status === 'failed' || r.status === 'timeout').length / finished.length : 0,
  };
}

export async function usageRollup(db: Db, factoryId: string, from: Date, to: Date, by: 'workItem' | 'agent' | 'harness' | 'model' | 'day') {
  const runs = await db.select({ r: t.runs, w: t.workItems.shortId }).from(t.runs).innerJoin(t.workItems, eq(t.runs.workItemId, t.workItems.id)).where(and(eq(t.runs.factoryId, factoryId), gte(t.runs.createdAt, from), lte(t.runs.createdAt, to)));
  const m = new Map<string, { key: string; runs: number; tokensIn: number; tokensOut: number; tokensCached: number; costUsd: number; premiumRequests: number }>();
  for (const { r, w } of runs) {
    const key = by === 'workItem' ? w : by === 'agent' ? r.agentName : by === 'harness' ? r.harness : by === 'model' ? r.model ?? 'unknown' : r.createdAt.toISOString().slice(0, 10);
    const e = m.get(key) ?? { key, runs: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, premiumRequests: 0 };
    e.runs++; e.tokensIn += r.tokensIn; e.tokensOut += r.tokensOut; e.tokensCached += r.tokensCached; e.costUsd += r.costUsd; e.premiumRequests += r.premiumRequests ?? 0;
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export { isNull };

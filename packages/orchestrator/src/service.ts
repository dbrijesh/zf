import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  ulid, slugify, notFound, invalid, conflict, forbidden, errMessage, isUniqueViolation, nullLogger, resultJsonSchema, emptyUsage, redactText,
  type Logger, type Phase, type HarnessType, type Question, type NormalisedEvent, type Usage, type WorkState, type RunResult,
} from '@zerovity/core';
import { tables as t, appendAudit, nextShortId, type Db, type JobQueue, type ArtifactStore, type DbSecrets, SecretResolver, type ExternalSecretsProvider, priceFor, computeCost } from '@zerovity/db';
import { collectSecretRefs, resolveDeep, type Issue } from '@zerovity/definition';
import { buildPreamble, type ResolvedAgent } from '@zerovity/harness-common';
import { LocalForge, type Forge, type ForgeResolver } from '@zerovity/forge-common';
import type { ContextItemInput } from '@zerovity/core';
import { next, initialState, isRunning, type Action, type MEvent, type MState, type Step } from './machine';
import { buildPhasePrompt } from './prompts';
import { Inbox } from './inbox';
import type { Advisor } from './advisor';
import type { DefinitionService, ActiveDefinition } from './definitions';
import type { ContextService } from './contexts';
import type { EventHub } from './hub';
import { bumpRev } from './hub';
import type { WorkItemRow, RunRow, RunPlan, RunOutcome, Notifier, FactoryRow, RepoRow, QuestionRow } from './types';

export interface OrchestratorDeps {
  db: Db; queue: JobQueue; artifacts: ArtifactStore; defs: DefinitionService; contexts: ContextService; advisor: Advisor; secrets: DbSecrets; hub: EventHub;
  notifier?: Notifier; forges?: ForgeResolver; log?: Logger; inbox?: Inbox; scoring?: { scoreRun(runId: string): Promise<number> };
  options?: { forceHarness?: HarnessType; externalSecrets?: ExternalSecretsProvider[]; maxEventBytes?: number };
}

export const RUN_QUEUE = 'run';
const HARNESS_CREDS: Record<HarnessType, { names: string[]; primary: string }> = {
  'claude-code': { names: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION'], primary: 'ANTHROPIC_API_KEY' },
  codex: { names: ['OPENAI_API_KEY', 'CODEX_API_KEY'], primary: 'OPENAI_API_KEY' },
  copilot: { names: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN'], primary: 'COPILOT_GITHUB_TOKEN' },
  cursor: { names: ['CURSOR_API_KEY'], primary: 'CURSOR_API_KEY' },
  fake: { names: [], primary: '' },
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class Orchestrator {
  readonly db: Db;
  readonly inbox: Inbox;
  private log: Logger;
  private chains = new Map<string, Promise<unknown>>();

  constructor(readonly d: OrchestratorDeps) {
    this.db = d.db;
    this.inbox = d.inbox ?? new Inbox(d.db);
    this.log = d.log ?? nullLogger;
  }

  /* ------------------------------------------------------------------ helpers */

  private async item(id: string): Promise<WorkItemRow> {
    const [w] = await this.db.select().from(t.workItems).where(eq(t.workItems.id, id));
    if (!w) throw notFound('Work item', id);
    return w;
  }
  private async factory(id: string): Promise<FactoryRow> {
    const [f] = await this.db.select().from(t.factories).where(eq(t.factories.id, id));
    if (!f) throw notFound('Factory', id);
    return f;
  }
  private async repoOf(w: WorkItemRow): Promise<RepoRow | undefined> {
    if (w.repoId) return (await this.db.select().from(t.repositories).where(eq(t.repositories.id, w.repoId)))[0];
    return (await this.db.select().from(t.repositories).where(eq(t.repositories.factoryId, w.factoryId)).orderBy(asc(t.repositories.createdAt)).limit(1))[0];
  }
  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }
  private touch(factoryId: string, e: Record<string, unknown> = {}) {
    this.d.hub.emit({ type: 'changed', factoryId, ...e });
    void bumpRev(this.db, factoryId).catch(() => undefined);
  }
  audit(factoryId: string, actor: string, action: string, subject: string, payload?: unknown) {
    return appendAudit(this.db, { chain: factoryId, factoryId, actor, action, subject, payload });
  }
  private toM(w: WorkItemRow): MState {
    const f = w.flags as { gateQueue?: string[]; gateNext?: WorkState; escalated?: boolean; loopLimitHit?: boolean; budgetBlocked?: boolean };
    return { state: w.state as WorkState, pausedState: (w.pausedState as WorkState | null) ?? undefined, gate: w.gate ?? undefined, gateQueue: f.gateQueue ?? [], gateNext: f.gateNext, loops: w.loops, failures: w.failures, triage: (w.triage as MState['triage']) ?? undefined, paths: w.pathsTouched, flags: { escalated: f.escalated, loopLimitHit: f.loopLimitHit, budgetBlocked: f.budgetBlocked } };
  }

  /* ------------------------------------------------------------------ intake */

  async createWorkItem(i: {
    factoryId: string; title: string; body?: string; source?: { type: string; ref?: string; url?: string }; requesterId?: string; requesterName?: string; repoId?: string;
    startPhase?: 'auto' | 'INTENT' | 'SPEC' | 'BUILD'; budgetUsd?: number; context?: ContextItemInput[]; actor?: string;
  }): Promise<WorkItemRow> {
    const f = await this.factory(i.factoryId);
    const active = await this.d.defs.getActive(f.id);
    if (!active) throw conflict('This factory has no valid definition yet');
    const actor = i.actor ?? i.requesterId ?? 'system';
    // the same external issue never creates two open work items (the unique index is the real guard; this is the fast path)
    const findOpenDup = async () => {
      if (!i.source?.ref) return undefined;
      const [dup] = await this.db.select().from(t.workItems).where(and(eq(t.workItems.factoryId, f.id), eq(t.workItems.sourceType, i.source.type), eq(t.workItems.sourceRef, i.source.ref), inArray(t.workItems.state, ['INTAKE', 'INTENT', 'SPEC', 'AWAITING_SPEC_APPROVAL', 'BUILD', 'VERIFY', 'AWAITING_GATE', 'SHIP', 'AWAITING_HANDOFF', 'NEEDS_INPUT', 'BLOCKED'])));
      return dup;
    };
    const known = await findOpenDup();
    if (known) return known;
    const { shortId, seq } = await nextShortId(this.db, f.id);
    const id = ulid();
    const repo = i.repoId ? (await this.db.select().from(t.repositories).where(eq(t.repositories.id, i.repoId)))[0] : (await this.db.select().from(t.repositories).where(eq(t.repositories.factoryId, f.id)).orderBy(asc(t.repositories.createdAt)).limit(1))[0];
    const branch = `zerovity/${shortId.toLowerCase()}-${slugify(i.title, 32)}`;
    try {
      await this.db.insert(t.workItems).values({ id, factoryId: f.id, shortId, seq, title: i.title.trim(), body: i.body ?? '', sourceType: i.source?.type ?? 'web', sourceRef: i.source?.ref ?? null, sourceUrl: i.source?.url ?? null, state: 'INTAKE', repoId: repo?.id ?? null, branch, requesterId: i.requesterId ?? null, budgetUsd: i.budgetUsd ?? active.definition.factory.agentDefaults.budget?.maxCostPerWorkItemUsd ?? null, startPhase: i.startPhase ?? 'auto' });
    } catch (e) {
      // two deliveries of the same event (a webhook retry, two API instances) raced: the loser returns the winner's item
      if (isUniqueViolation(e)) { const dup = await findOpenDup(); if (dup) return dup; }
      throw e;
    }
    await this.audit(f.id, actor, 'work_item.created', shortId, { title: i.title, source: i.source?.type ?? 'web', sourceRef: i.source?.ref });
    if (i.body?.trim()) await this.db.insert(t.messages).values({ id: ulid(), workItemId: id, authorKind: 'requester', authorId: i.requesterId ?? null, authorName: i.requesterName ?? null, body: i.body.trim(), channel: i.source?.type ?? 'web', externalRef: i.source?.ref ?? null });
    for (const c of i.context ?? []) await this.d.contexts.create(f.orgId, { ...c, layer: 'workItem', scopeId: id }, actor, f.id);
    let start: 'INTENT' | 'SPEC' | 'BUILD';
    if (i.startPhase && i.startPhase !== 'auto') start = i.startPhase;
    else {
      const available = (['INTENT', 'SPEC', 'BUILD'] as const).filter((p) => this.d.defs.agentForPhase(active, p));
      const dec = await this.d.advisor.decideIntake({ title: i.title, body: i.body ?? '', factory: f.name, phasesAvailable: available });
      start = available.includes(dec.value.startPhase) ? dec.value.startPhase : available[0] ?? 'INTENT';
      await this.audit(f.id, `foreman:${this.d.advisor.name}`, 'foreman.decision', shortId, { decision: 'intake', input: { titleHash: sha(i.title), bodyHash: sha(i.body ?? '') }, output: dec.value, source: dec.source, fallbackReason: dec.fallbackReason, model: dec.model, policy: { specApproval: !!active.policy.specApproval } });
      if (dec.value.askFirst) await this.say(await this.item(id), 'questions', dec.value.askFirst);
    }
    await this.applyEvent(id, { type: 'created', startAt: start }, actor);
    return this.item(id);
  }

  /* ------------------------------------------------------------------ state machine driver */

  async applyEvent(workItemId: string, event: MEvent, actor = 'system'): Promise<{ step: Step; item: WorkItemRow }> {
    const res = await this.locked(workItemId, async () => {
      const w = await this.item(workItemId);
      const active = await this.d.defs.getActive(w.factoryId);
      if (!active) throw conflict('Factory has no valid definition');
      const before = this.toM(w);
      const step = next(before, event, active.policy);
      if (step.ignored) return { step, item: w, from: w.state };
      const s = step.state;
      const flags = { ...(w.flags as Record<string, unknown>), gateQueue: s.gateQueue, gateNext: s.gateNext, escalated: s.flags.escalated, loopLimitHit: s.flags.loopLimitHit, budgetBlocked: s.flags.budgetBlocked };
      const running = isRunning(s.state);
      const [row] = await this.db.update(t.workItems).set({
        state: s.state, phase: running ? s.state : w.phase, pausedState: s.pausedState ?? null, gate: s.gate ?? null, loops: s.loops, failures: s.failures, triage: s.triage ? (s.triage as Record<string, unknown>) : w.triage, pathsTouched: s.paths, flags,
        stateSince: s.state !== w.state ? new Date() : w.stateSince, completedAt: s.state === 'COMPLETE' ? new Date() : w.completedAt, updatedAt: new Date(),
      }).where(eq(t.workItems.id, workItemId)).returning();
      return { step, item: row, from: w.state };
    });
    if (res.step.ignored) {
      this.log.info('event ignored', { workItemId, event: event.type, state: res.from });
      return { step: res.step, item: res.item };
    }
    await this.audit(res.item.factoryId, actor, 'work_item.transition', res.item.shortId, { from: res.from, to: res.step.state.state, event: event.type, label: res.step.label, actions: res.step.actions.map((a) => a.type) });
    this.touch(res.item.factoryId, { workItemId, state: res.step.state.state });
    this.d.hub.emit({ type: 'transition', factoryId: res.item.factoryId, workItemId, from: res.from, to: res.step.state.state });
    for (const a of res.step.actions) {
      try { await this.runAction(res.item, a, event); } catch (e) { this.log.error('action failed', { workItemId, action: a.type, error: errMessage(e) }); await this.audit(res.item.factoryId, 'system', 'action.failed', res.item.shortId, { action: a.type, error: errMessage(e) }).catch(() => undefined); }
    }
    return { step: res.step, item: await this.item(workItemId) };
  }

  private async runAction(w: WorkItemRow, a: Action, cause: MEvent): Promise<void> {
    const f = await this.factory(w.factoryId);
    switch (a.type) {
      case 'dispatchRun': return void (await this.enqueueRun(w.id, a.phase, a.reason, a.resume));
      case 'resolveInbox': await this.inbox.resolveByRef(w.id, a.refPrefix); return;
      case 'cancelRuns': return this.cancelRuns(w.id);
      case 'openDraftPr': return void (await this.openDraftPr(w.id));
      case 'requestGate': return void (await this.requestGate(w.id, a.gate));
      case 'complete': await this.audit(w.factoryId, 'system', 'work_item.completed', w.shortId, {}); return;
      case 'postSource': return this.postSource(await this.item(w.id), a.kind);
      case 'createInbox': return this.createInbox(await this.item(w.id), f, a.kind, a.ref, cause);
    }
  }

  /* ------------------------------------------------------------------ runs: queue */

  async enqueueRun(workItemId: string, phase: Phase, reason: string, resume: boolean, agentName?: string): Promise<string | undefined> {
    const w = await this.item(workItemId);
    const active = await this.d.defs.getActive(w.factoryId);
    if (!active) { await this.applyEvent(workItemId, { type: 'fatal' }); return undefined; }
    const agent = agentName ? active.agents.get(agentName) : this.d.defs.agentForPhase(active, phase);
    if (!agent) {
      if (phase === 'BUILD') { await this.say(w, 'blocked', 'This factory has no agent for the BUILD phase.'); await this.applyEvent(workItemId, { type: 'fatal' }); return undefined; }
      await this.audit(w.factoryId, 'system', 'phase.skipped', w.shortId, { phase, reason: 'no agent for phase' });
      await this.applyEvent(workItemId, { type: 'run_done' });
      return undefined;
    }
    const budget = w.budgetUsd ?? active.definition.factory.agentDefaults.budget?.maxCostPerWorkItemUsd;
    if (budget && w.costUsd >= budget && reason !== 'resume_answers') {
      await this.askBudget(w, budget);
      await this.applyEvent(workItemId, { type: 'budget_exceeded' });
      return undefined;
    }
    const h = this.d.defs.effectiveHarness(active, agent, this.d.options?.forceHarness);
    const [{ n }] = await this.db.select({ n: count() }).from(t.runs).where(and(eq(t.runs.workItemId, w.id), eq(t.runs.phase, phase)));
    const id = ulid();
    const runner = agent.fm.runner ?? active.definition.factory.agentDefaults.runner ?? 'default';
    await this.db.insert(t.runs).values({ id, workItemId: w.id, factoryId: w.factoryId, agentName: agent.name, phase, harness: h.type, model: h.model ?? (h.type === 'fake' ? 'fake-model' : null), runner, status: 'queued', attempt: Number(n) + 1, definitionVersionId: active.versionId });
    await this.d.queue.enqueue(RUN_QUEUE, { runId: id, reason, resume }, { singletonKey: `run:${id}`, maxAttempts: 1 });
    await this.audit(w.factoryId, 'system', 'run.queued', w.shortId, { runId: id, agent: agent.name, harness: h.type, model: h.model, phase, reason, definitionCommit: active.commit });
    this.touch(w.factoryId, { workItemId: w.id, runId: id });
    return id;
  }

  private async cancelRuns(workItemId: string) {
    const rows = await this.db.select().from(t.runs).where(and(eq(t.runs.workItemId, workItemId), inArray(t.runs.status, ['queued', 'running'])));
    for (const r of rows) {
      if (r.status === 'queued') {
        await this.db.update(t.runs).set({ status: 'cancelled', endedAt: new Date(), exitReason: 'cancelled', updatedAt: new Date() }).where(eq(t.runs.id, r.id));
        await this.d.queue.cancelWhere(RUN_QUEUE, { runId: r.id });
      } else await this.db.insert(t.kv).values({ key: `cancel:${r.id}`, value: true }).onConflictDoNothing();
    }
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    const [r] = await this.db.select().from(t.kv).where(eq(t.kv.key, `cancel:${runId}`));
    return !!r;
  }

  /** The worker asks before starting a claimed run (concurrency limits, spec 10.5). */
  async canStart(runId: string): Promise<{ ok: boolean; reason?: string }> {
    const [r] = await this.db.select().from(t.runs).where(eq(t.runs.id, runId));
    if (!r) return { ok: false, reason: 'run not found' };
    if (r.status !== 'queued') return { ok: false, reason: `run is ${r.status}` };
    const active = await this.d.defs.getActive(r.factoryId);
    const lim = active?.definition.factory.limits ?? { maxConcurrentRuns: 4, maxRunsPerRepo: 2 };
    const [f] = await this.db.select({ paused: t.factories.paused }).from(t.factories).where(eq(t.factories.id, r.factoryId));
    if (f?.paused) return { ok: false, reason: 'factory is paused' };
    const [{ n }] = await this.db.select({ n: count() }).from(t.runs).where(and(eq(t.runs.factoryId, r.factoryId), eq(t.runs.status, 'running')));
    if (Number(n) >= lim.maxConcurrentRuns) return { ok: false, reason: 'factory concurrency limit' };
    const w = await this.item(r.workItemId);
    if (w.repoId) {
      const [{ m }] = await this.db.select({ m: count() }).from(t.runs).innerJoin(t.workItems, eq(t.runs.workItemId, t.workItems.id)).where(and(eq(t.runs.status, 'running'), eq(t.workItems.repoId, w.repoId)));
      if (Number(m) >= lim.maxRunsPerRepo) return { ok: false, reason: 'repository concurrency limit' };
    }
    return { ok: true };
  }

  /* ------------------------------------------------------------------ runs: plan */

  async prepareRun(runId: string, hints: { reason?: string; resume?: boolean; message?: string } = {}): Promise<RunPlan> {
    const [run] = await this.db.select().from(t.runs).where(eq(t.runs.id, runId));
    if (!run) throw notFound('Run', runId);
    const w = await this.item(run.workItemId);
    const f = await this.factory(w.factoryId);
    const active = await this.d.defs.getActive(w.factoryId);
    if (!active) throw conflict('Factory has no valid definition');
    const agentDef = active.agents.get(run.agentName);
    if (!agentDef) throw notFound('Agent', run.agentName);
    const repo = await this.repoOf(w);
    const eff = this.d.defs.skillsFor(active, agentDef);
    const harness = this.d.defs.effectiveHarness(active, agentDef, this.d.options?.forceHarness);
    const defaults = active.definition.factory.agentDefaults;
    const agent: ResolvedAgent = { name: agentDef.name, phase: agentDef.fm.phase, role: agentDef.fm.role, body: agentDef.body, skills: eff.skills.map((s) => ({ name: s.name, description: s.description, files: s.files })), outputs: agentDef.fm.outputs, harness: { type: harness.type, model: run.model ?? harness.model, reasoning: harness.reasoning }, mcpServers: agentDef.fm.mcpServers };
    const runnerName = agentDef.fm.runner ?? defaults.runner ?? 'default';
    const runner = active.definition.runners[runnerName] ?? { description: 'Built-in default runner', image: process.env.ZF_RUNNER_IMAGE ?? 'zerovity-runner-base:latest', setupCommands: [], resources: { cpus: 2, memoryGb: 4 }, network: { egress: 'allowlist' as const, allow: ['github.com', 'api.anthropic.com', 'api.openai.com', 'api.githubcopilot.com', 'cursor.sh', 'cursor.com', 'cursorapi.com', 'registry.npmjs.org'] } };

    // context inputs (the worker assembles after cloning so repo convention files can be included)
    const repoKey = repo ? `${repo.owner}/${repo.name}` : undefined;
    const items = await this.d.contexts.candidatesFor({ id: w.id, factoryId: w.factoryId, orgId: f.orgId, repoKey });
    const qa = await this.d.contexts.qaFor(w.id);
    const toggles = await this.d.contexts.toggles(w.id);

    // secrets: only what this agent declared plus the harness credential and gateway
    const resolver = new SecretResolver(this.d.secrets, f.orgId, f.id, this.d.options?.externalSecrets);
    const env: Record<string, string> = {};
    const cred = HARNESS_CREDS[harness.type];
    const wanted = new Set<string>([...cred.names, ...agentDef.fm.secrets]);
    const mcpDecl = Object.fromEntries(agentDef.fm.mcpServers.filter((n) => n in active.definition.factory.mcpServers).map((n) => [n, active.definition.factory.mcpServers[n]]));
    for (const r of collectSecretRefs(mcpDecl)) wanted.add(r);
    const gw = active.definition.factory.gateway;
    for (const r of collectSecretRefs(gw ?? {})) wanted.add(r);
    const values = await resolver.resolve([...wanted]);
    for (const n of [...cred.names, ...agentDef.fm.secrets]) if (values[n] !== undefined) env[n] = values[n];
    if (agentDef.fm.credential && cred.primary) {
      const [c] = await this.db.select().from(t.connections).where(and(eq(t.connections.orgId, f.orgId), eq(t.connections.displayName, agentDef.fm.credential)));
      if (c?.secretId) { const v = await this.d.secrets.getById(c.secretId); if (v) env[cred.primary] = v; }
    }
    const lookup = (n: string) => values[n];
    if (gw?.anthropicBaseUrl && harness.type === 'claude-code') env.ANTHROPIC_BASE_URL = resolveDeep(gw.anthropicBaseUrl, lookup);
    if (gw?.openaiBaseUrl && harness.type === 'codex') env.OPENAI_BASE_URL = resolveDeep(gw.openaiBaseUrl, lookup);
    env.ZEROVITY_WORK_ITEM = w.shortId; env.ZEROVITY_PHASE = run.phase; env.ZEROVITY_AGENT = agentDef.name;
    const mcpServers = resolveDeep(mcpDecl, lookup) as RunPlan['mcpServers'];

    const reason = hints.reason ?? 'start';
    const [sess] = await this.db.select().from(t.agentSessions).where(and(eq(t.agentSessions.workItemId, w.id), eq(t.agentSessions.agentName, agentDef.name)));
    const resumeSessionId = hints.resume && sess && sess.harness === harness.type ? sess.sessionId : undefined;
    const lastGate = (await this.db.select().from(t.gates).where(eq(t.gates.workItemId, w.id)).orderBy(desc(t.gates.requestedAt)))[0];
    const lastVerify = (await this.db.select().from(t.runs).where(and(eq(t.runs.workItemId, w.id), eq(t.runs.phase, 'VERIFY'), eq(t.runs.status, 'done'))).orderBy(desc(t.runs.createdAt)).limit(1))[0];
    const lastFail = (await this.db.select().from(t.runs).where(and(eq(t.runs.workItemId, w.id), eq(t.runs.phase, run.phase), inArray(t.runs.status, ['failed', 'timeout']))).orderBy(desc(t.runs.createdAt)).limit(1))[0];
    const comments = lastGate?.status === 'changes_requested' ? [lastGate.reason, ...lastGate.comments.map((c) => `${c.file ? `${c.file}${c.line ? `:${c.line}` : ''}: ` : ''}${c.text}`)].filter(Boolean) as string[] : undefined;
    const specFileName = `docs/specs/${w.shortId}.md`;
    const prompt = buildPhasePrompt({
      phase: run.phase, reason: reason as 'start', loops: w.loops, maxLoops: active.policy.maxRevisionLoops, comments, findings: (lastVerify?.resultJson as RunResult | null)?.findings, lastError: lastFail?.exitReason ?? undefined, specPath: specFileName, hasPriorSession: !!resumeSessionId,
      workItem: { shortId: w.shortId, title: w.title, body: w.body, sourceLabel: w.sourceUrl ?? (w.sourceRef ? `${w.sourceType} ${w.sourceRef}` : undefined) },
    });
    const finalPrompt = hints.message && reason === 'followup' ? hints.message : prompt;
    const instructions = buildPreamble({ agent: { name: agentDef.name, body: agentDef.body, outputs: agentDef.fm.outputs, skills: agent.skills }, phase: run.phase, workItemId: w.shortId, title: w.title });
    return {
      run: { id: run.id, workItemId: w.id, factoryId: f.id, agentName: agentDef.name, phase: run.phase, harness: harness.type, model: agent.harness.model, attempt: run.attempt, reason },
      workItem: { id: w.id, shortId: w.shortId, title: w.title, body: w.body, branch: w.branch ?? `zerovity/${w.shortId.toLowerCase()}`, sourceUrl: w.sourceUrl, prUrl: w.prUrl, prNumber: w.prNumber },
      factory: { id: f.id, orgId: f.orgId, name: f.name, alias: f.alias },
      repo: repo ? { id: repo.id, forge: repo.forge, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch, cloneUrl: repo.cloneUrl, installId: repo.installId } : undefined,
      agent, runner: { ...runner, name: runnerName }, instructions, prompt: finalPrompt,
      contextInput: { items, qa, toggles, agent: { name: agentDef.name, phase: run.phase, contextScopes: agentDef.fm.contextScopes, tokenBudget: agentDef.fm.contextTokenBudget }, workItem: { id: w.id, shortId: w.shortId, title: w.title, body: w.body, factoryId: w.factoryId, repoKey } },
      env, mcpServers,
      limits: { maxMinutes: agentDef.fm.maxRunMinutes ?? defaults.maxRunMinutes ?? 60, idleMinutes: defaults.idleTimeoutMinutes ?? 10, maxTokens: defaults.budget?.maxTokensPerRun ?? 2_000_000 },
      resumeSessionId, skillFiles: agent.skills, definitionVersionId: active.versionId, resultSchema: JSON.stringify(resultJsonSchema(), null, 2), specFileName,
      concurrency: { factory: active.definition.factory.limits?.maxConcurrentRuns ?? 4, repo: active.definition.factory.limits?.maxRunsPerRepo ?? 2 },
    };
  }

  async markRunStarted(runId: string, o: { contextBundleHash?: string; baseSha?: string; sessionId?: string }): Promise<void> {
    const [run] = await this.db.update(t.runs).set({ status: 'running', startedAt: new Date(), contextBundleHash: o.contextBundleHash ?? null, baseSha: o.baseSha ?? null, sessionId: o.sessionId ?? null, updatedAt: new Date() }).where(eq(t.runs.id, runId)).returning();
    const w = await this.item(run.workItemId);
    await this.audit(w.factoryId, 'worker', 'run.started', w.shortId, { runId, agent: run.agentName, harness: run.harness, model: run.model, contextBundleHash: o.contextBundleHash });
    this.touch(w.factoryId, { workItemId: w.id, runId });
  }

  /** Persist normalised events (redacted), keep live usage and cost current. Returns the new cursor. */
  async recordEvents(runId: string, events: Array<NormalisedEvent | { kind: 'system.status' | 'system.followup'; text: string; by?: string }>): Promise<number> {
    if (!events.length) return 0;
    const [run] = await this.db.select().from(t.runs).where(eq(t.runs.id, runId));
    if (!run) throw notFound('Run', runId);
    const start = run.eventCount + 1;
    const rows = events.map((e, i) => ({ runId, seq: start + i, kind: e.kind, payload: JSON.parse(redactText(JSON.stringify(e))) as Record<string, unknown>, ts: new Date() }));
    await this.db.insert(t.runEvents).values(rows);
    let usage: Usage | undefined;
    for (const e of events) if (e.kind === 'usage') { usage ??= emptyUsage(); usage.inputTokens += e.inputTokens; usage.outputTokens += e.outputTokens; usage.cachedTokens += e.cachedTokens ?? 0; if (e.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + e.costUsd; if (e.premiumRequests !== undefined) usage.premiumRequests = (usage.premiumRequests ?? 0) + e.premiumRequests; }
    const set: Record<string, unknown> = { eventCount: start + events.length - 1, updatedAt: new Date() };
    const sess = events.find((e) => e.kind === 'session.started');
    if (sess && sess.kind === 'session.started') { set.sessionId = sess.sessionId; if (sess.model && !run.model) set.model = sess.model; }
    if (usage) {
      const price = await priceFor(this.db, run.model, run.harness);
      const cost = computeCost(usage, price);
      Object.assign(set, { tokensIn: sql`${t.runs.tokensIn} + ${usage.inputTokens}`, tokensOut: sql`${t.runs.tokensOut} + ${usage.outputTokens}`, tokensCached: sql`${t.runs.tokensCached} + ${usage.cachedTokens}`, costUsd: sql`${t.runs.costUsd} + ${cost}`, ...(usage.premiumRequests ? { premiumRequests: sql`coalesce(${t.runs.premiumRequests}, 0) + ${usage.premiumRequests}` } : {}) });
      await this.db.update(t.workItems).set({ costUsd: sql`${t.workItems.costUsd} + ${cost}`, tokensIn: sql`${t.workItems.tokensIn} + ${usage.inputTokens}`, tokensOut: sql`${t.workItems.tokensOut} + ${usage.outputTokens}`, updatedAt: new Date() }).where(eq(t.workItems.id, run.workItemId));
    }
    await this.db.update(t.runs).set(set).where(eq(t.runs.id, runId));
    this.d.hub.emit({ type: 'run.events', runId, factoryId: run.factoryId, workItemId: run.workItemId, upTo: start + events.length - 1 });
    return start + events.length - 1;
  }

  async checkBudget(runId: string): Promise<{ exceeded: 'cost' | 'tokens' | null }> {
    const [run] = await this.db.select().from(t.runs).where(eq(t.runs.id, runId));
    const w = await this.item(run.workItemId);
    const active = await this.d.defs.getActive(w.factoryId);
    const maxTokens = active?.definition.factory.agentDefaults.budget?.maxTokensPerRun;
    if (maxTokens && run.tokensIn + run.tokensOut > maxTokens) return { exceeded: 'tokens' };
    if (w.budgetUsd && w.costUsd > w.budgetUsd * 1.25) return { exceeded: 'cost' };
    return { exceeded: null };
  }

  /* ------------------------------------------------------------------ runs: finish */

  async finishRun(runId: string, o: RunOutcome): Promise<void> {
    const [run] = await this.db.select().from(t.runs).where(eq(t.runs.id, runId));
    if (!run) throw notFound('Run', runId);
    if (['done', 'failed', 'needs_input', 'blocked', 'timeout', 'cancelled'].includes(run.status)) return; // idempotent
    const w = await this.item(run.workItemId);
    const result = o.result;
    let status: string = o.status === 'done' ? (result?.status === 'needs_input' ? 'needs_input' : result?.status === 'blocked' ? 'blocked' : result?.status === 'failed' ? 'failed' : 'done') : o.status === 'budget' ? 'failed' : o.status;
    if (o.status === 'done' && !result) status = 'failed';
    await this.db.update(t.runs).set({ status, endedAt: new Date(), exitReason: o.exitReason ?? (status === 'failed' && !result ? 'no_result' : null), sessionId: o.sessionId ?? run.sessionId, resultJson: result ? (result as unknown as Record<string, unknown>) : null, headSha: o.headSha ?? null, updatedAt: new Date() }).where(eq(t.runs.id, runId));
    if (o.sessionId) await this.db.insert(t.agentSessions).values({ workItemId: w.id, agentName: run.agentName, harness: run.harness, sessionId: o.sessionId }).onConflictDoUpdate({ target: [t.agentSessions.workItemId, t.agentSessions.agentName], set: { sessionId: o.sessionId, harness: run.harness, updatedAt: new Date() } });
    if (run.kind === 'followup') { this.touch(w.factoryId, { workItemId: w.id, runId }); return; } // follow-ups never move the state machine
    if ((w.flags as { test?: boolean }).test) { await this.db.update(t.workItems).set({ state: 'COMPLETE', completedAt: new Date() }).where(eq(t.workItems.id, w.id)); this.touch(w.factoryId, { workItemId: w.id, runId }); return; } // test runs never drive the state machine
    await this.audit(w.factoryId, 'worker', 'run.ended', w.shortId, { runId, status, exitReason: o.exitReason, summary: result?.summary?.slice(0, 500), recommendation: result?.recommendation });
    if (o.error) await this.recordEvents(runId, [{ kind: 'error', message: redactText(o.error).slice(0, 2000) }]).catch(() => undefined);
    // learn from the run before the machine moves on
    if (result?.pathsTouched?.length) await this.db.update(t.workItems).set({ pathsTouched: [...new Set([...w.pathsTouched, ...result.pathsTouched])] }).where(eq(t.workItems.id, w.id));
    if (result?.status === 'done' || result?.status === 'blocked') await this.postAgentSummary(w, run, result);
    this.touch(w.factoryId, { workItemId: w.id, runId });
    if (this.d.scoring && status !== 'cancelled') await this.d.scoring.scoreRun(runId).catch((e) => this.log.warn('scoring failed', { runId, error: errMessage(e) }));
    if (status !== 'done' && status !== 'needs_input' && o.status === 'cancelled') return;
    if (o.status === 'budget') { const b = w.budgetUsd ?? 25; await this.askBudget(w, b, `A run stopped because the budget was reached.`); await this.applyEvent(w.id, { type: 'budget_exceeded' }); return; }
    // a work item that moved on (cancelled, etc.) ignores a late run result
    const cur = await this.item(w.id);
    if (cur.state !== run.phase) { this.log.warn('late run result ignored', { runId, state: cur.state, phase: run.phase }); return; }
    if (status === 'done') { await this.applyEvent(w.id, { type: 'run_done', result: { triage: result?.triage ? { ...result.triage } : undefined, recommendation: result?.recommendation, pathsTouched: result?.pathsTouched } }, 'run:' + runId); return; }
    if (status === 'needs_input') { await this.openQuestions(w, run, result?.questions ?? [], result?.summary); await this.applyEvent(w.id, { type: 'run_needs_input' }, 'run:' + runId); return; }
    if (status === 'blocked') { await this.applyEvent(w.id, { type: 'run_blocked' }, 'run:' + runId); return; }
    await this.applyEvent(w.id, { type: 'run_failed' }, 'run:' + runId);
  }

  private async postAgentSummary(w: WorkItemRow, run: RunRow, r: RunResult) {
    await this.db.insert(t.messages).values({ id: ulid(), workItemId: w.id, authorKind: 'agent', authorName: run.agentName, body: r.summary || `${run.agentName} finished ${run.phase}.`, channel: 'internal', meta: { runId: run.id, phase: run.phase, status: r.status } });
  }

  private async openQuestions(w: WorkItemRow, run: RunRow, qs: Question[], summary?: string) {
    const f = await this.factory(w.factoryId);
    const rows: QuestionRow[] = [];
    for (const q of qs) {
      const id = ulid();
      await this.db.insert(t.questions).values({ id, workItemId: w.id, runId: run.id, qid: q.id, kind: q.kind, text: q.text, options: q.options ?? null, why: q.why ?? null, askedBy: run.agentName, phase: run.phase });
      rows.push((await this.db.select().from(t.questions).where(eq(t.questions.id, id)))[0]);
      await this.inbox.create({ orgId: f.orgId, factoryId: f.id, workItemId: w.id, kind: q.kind === 'context_request' ? 'context_request' : 'question', title: `${w.shortId} · ${q.text.length > 90 ? q.text.slice(0, 89) + '…' : q.text}`, body: q.text, refKey: `q:${id}`, payload: { questionId: id, options: q.options ?? [], why: q.why, agent: run.agentName, harness: run.harness, phase: run.phase } });
    }
    if (rows.length) {
      const dec = await this.d.advisor.rewriteQuestions({ title: w.title, agent: run.agentName, questions: qs, summary });
      await this.audit(w.factoryId, `foreman:${this.d.advisor.name}`, 'foreman.decision', w.shortId, { decision: 'rewrite_questions', questionIds: rows.map((r) => r.id), output: dec.value, source: dec.source, fallbackReason: dec.fallbackReason });
      await this.say(w, 'questions', dec.value.message);
    }
  }

  private async askBudget(w: WorkItemRow, budget: number, lead = 'This work item reached its budget.') {
    const f = await this.factory(w.factoryId);
    const [open] = await this.db.select().from(t.questions).where(and(eq(t.questions.workItemId, w.id), eq(t.questions.qid, 'budget'), sql`${t.questions.answer} is null`));
    if (open) return;
    const id = ulid();
    const options = ['Raise by $10', 'Raise by $25', 'Raise by $50', 'Stop this work item'];
    const text = `${lead} It has used $${w.costUsd.toFixed(2)} of $${budget.toFixed(2)}. Raise the budget or stop?`;
    await this.db.insert(t.questions).values({ id, workItemId: w.id, qid: 'budget', kind: 'decision', text, options, why: 'Budget guard before the next agent run', askedBy: 'foreman', phase: w.phase });
    await this.inbox.create({ orgId: f.orgId, factoryId: f.id, workItemId: w.id, kind: 'question', title: `${w.shortId} · Budget reached`, body: text, refKey: `q:${id}`, payload: { questionId: id, options, budget: true } });
    await this.say(w, 'questions', text);
  }

  /* ------------------------------------------------------------------ questions */

  async answerQuestion(questionId: string, a: { answer: string; by: string; byName?: string; contextItemId?: string }): Promise<QuestionRow> {
    const [q] = await this.db.select().from(t.questions).where(eq(t.questions.id, questionId));
    if (!q) throw notFound('Question', questionId);
    if (q.answer !== null) throw conflict('Question already answered');
    const w = await this.item(q.workItemId);
    const answer = a.answer.trim() || (a.contextItemId ? 'Attachment: see attached context item' : '');
    if (!answer) throw invalid('An answer is required');
    await this.db.update(t.questions).set({ answer, answeredBy: a.byName ?? a.by, answeredAt: new Date(), contextItemId: a.contextItemId ?? null, updatedAt: new Date() }).where(eq(t.questions.id, questionId));
    await this.inbox.resolveByRef(w.id, `q:${questionId}`, 'answered', a.by);
    await this.db.insert(t.messages).values({ id: ulid(), workItemId: w.id, authorKind: 'requester', authorId: a.by, authorName: a.byName ?? null, body: answer, channel: 'web', meta: { questionId } });
    await this.audit(w.factoryId, a.by, 'question.answered', w.shortId, { questionId, qid: q.qid, kind: q.kind, answerHash: sha(answer), contextItemId: a.contextItemId });
    if (q.qid === 'budget') await this.applyBudgetAnswer(w, answer);
    this.touch(w.factoryId, { workItemId: w.id });
    const [{ n }] = await this.db.select({ n: count() }).from(t.questions).where(and(eq(t.questions.workItemId, w.id), sql`${t.questions.answer} is null`));
    const cur = await this.item(w.id);
    if (Number(n) === 0 && cur.state === 'NEEDS_INPUT') await this.applyEvent(w.id, { type: 'questions_answered' }, a.by);
    else if (cur.state === 'CANCELLED') return (await this.db.select().from(t.questions).where(eq(t.questions.id, questionId)))[0];
    return (await this.db.select().from(t.questions).where(eq(t.questions.id, questionId)))[0];
  }

  private async applyBudgetAnswer(w: WorkItemRow, answer: string) {
    const m = /raise by \$?(\d+(?:\.\d+)?)/i.exec(answer) ?? /^\$?(\d+(?:\.\d+)?)$/.exec(answer.trim());
    if (m) {
      const nb = (w.budgetUsd ?? 0) + Number(m[1]);
      await this.db.update(t.workItems).set({ budgetUsd: Math.max(nb, w.costUsd + Number(m[1])) }).where(eq(t.workItems.id, w.id));
    } else if (/stop/i.test(answer)) {
      await this.db.update(t.questions).set({ answer: 'Stop this work item' }).where(and(eq(t.questions.workItemId, w.id), eq(t.questions.qid, 'budget')));
      setTimeout(() => void this.cancelWorkItem(w.id, 'budget-owner').catch(() => undefined), 0);
    }
  }

  /** A person replies in a source thread or the web conversation. Routes to the oldest open question when one waits. */
  async ingestMessage(workItemId: string, m: { body: string; authorName?: string; authorId?: string; channel: string; externalRef?: string }): Promise<{ routedToQuestion?: string }> {
    const w = await this.item(workItemId);
    if (m.externalRef) {
      const [dup] = await this.db.select().from(t.messages).where(and(eq(t.messages.workItemId, w.id), eq(t.messages.externalRef, m.externalRef)));
      if (dup) return {};
    }
    const open = await this.db.select().from(t.questions).where(and(eq(t.questions.workItemId, w.id), sql`${t.questions.answer} is null`)).orderBy(asc(t.questions.createdAt));
    if (w.state === 'NEEDS_INPUT' && open.length) {
      const numbered = new Map<number, string>();
      for (const mm of m.body.matchAll(/^\s*(\d+)[.)]\s*(.+)$/gm)) numbered.set(Number(mm[1]), mm[2].trim());
      if (open.length > 1 && numbered.size >= 2) {
        let routed: string | undefined;
        for (const [i, q] of open.entries()) { const ans = numbered.get(i + 1); if (ans) { await this.answerQuestion(q.id, { answer: ans, by: m.authorId ?? 'external', byName: m.authorName }); routed ??= q.id; } }
        return { routedToQuestion: routed };
      }
      await this.answerQuestion(open[0].id, { answer: m.body.trim(), by: m.authorId ?? 'external', byName: m.authorName });
      return { routedToQuestion: open[0].id };
    }
    await this.db.insert(t.messages).values({ id: ulid(), workItemId: w.id, authorKind: 'requester', authorId: m.authorId ?? null, authorName: m.authorName ?? null, body: m.body.trim(), channel: m.channel, externalRef: m.externalRef ?? null });
    await this.audit(w.factoryId, m.authorId ?? 'external', 'message.received', w.shortId, { channel: m.channel, bodyHash: sha(m.body) });
    this.touch(w.factoryId, { workItemId: w.id });
    return {};
  }

  /* ------------------------------------------------------------------ gates */

  private async artifactText(runId: string, name: string): Promise<string | undefined> {
    return (await this.d.artifacts.get(`runs/${runId}/out/${name}`))?.toString('utf8');
  }
  async latestRun(workItemId: string, phase: string, status = 'done'): Promise<RunRow | undefined> {
    return (await this.db.select().from(t.runs).where(and(eq(t.runs.workItemId, workItemId), eq(t.runs.phase, phase), eq(t.runs.status, status))).orderBy(desc(t.runs.createdAt)).limit(1))[0];
  }
  async specText(workItemId: string): Promise<string | undefined> {
    const r = await this.latestRun(workItemId, 'SPEC');
    return r ? this.artifactText(r.id, 'spec.md') : undefined;
  }

  private async requestGate(workItemId: string, gateName: string): Promise<string> {
    const w = await this.item(workItemId);
    let subject: string;
    if (gateName === 'specApproval') subject = (await this.specText(workItemId)) ?? '';
    else {
      const r = (await this.latestRun(workItemId, gateName === 'dbReview' ? 'VERIFY' : 'BUILD')) ?? (await this.latestRun(workItemId, 'BUILD'));
      const diff = r ? (await this.d.artifacts.get(`runs/${r.id}/diff.patch`))?.toString('utf8') : '';
      subject = (diff ?? '') + JSON.stringify(r?.resultJson ?? {});
    }
    const id = ulid();
    await this.db.insert(t.gates).values({ id, workItemId: w.id, type: gateName, status: 'pending', subjectHash: sha(subject) });
    await this.audit(w.factoryId, 'system', 'gate.requested', w.shortId, { gateId: id, gate: gateName, subjectHash: sha(subject) });
    return id;
  }

  async pendingGate(workItemId: string): Promise<typeof t.gates.$inferSelect | undefined> {
    return (await this.db.select().from(t.gates).where(and(eq(t.gates.workItemId, workItemId), eq(t.gates.status, 'pending'))).orderBy(desc(t.gates.requestedAt)).limit(1))[0];
  }

  async decideGate(gateId: string, d: { decision: 'approve' | 'changes'; by: string; byName?: string; groups?: string[]; role?: string; reason?: string; comments?: Array<{ file?: string; line?: number; text: string }>; reauthenticated?: boolean }): Promise<typeof t.gates.$inferSelect> {
    const [g] = await this.db.select().from(t.gates).where(eq(t.gates.id, gateId));
    if (!g) throw notFound('Gate', gateId);
    if (g.status !== 'pending') throw conflict(`Gate already ${g.status}`);
    const w = await this.item(g.workItemId);
    const active = await this.d.defs.getActive(w.factoryId);
    const rule = active?.policy.gate(g.type);
    // authorisation: approver role or membership of a named group/user (spec 12.4)
    const rank = ['viewer', 'member', 'approver', 'factory_owner', 'org_admin'];
    const roleOk = rank.indexOf(d.role ?? 'viewer') >= rank.indexOf('approver');
    const named = !!rule && ((rule.approverGroups.length || rule.approverUsers.length) > 0);
    const groupOk = !named || rule!.approverGroups.some((x) => (d.groups ?? []).includes(x)) || rule!.approverUsers.includes(d.by) || ['factory_owner', 'org_admin'].includes(d.role ?? '');
    if (!roleOk || !groupOk) throw forbidden(named ? `Only ${[...rule!.approverGroups, ...rule!.approverUsers].join(', ')} can decide ${g.type}` : 'Approving requires the approver role');
    if (rule?.requireReason && !d.reason?.trim()) throw invalid('A reason is required for this gate');
    if (rule?.reauthenticate && !d.reauthenticated) throw forbidden('This gate requires re-authentication (e-signature)');
    const status = d.decision === 'approve' ? 'approved' : 'changes_requested';
    await this.db.update(t.gates).set({ status, decidedBy: d.byName ?? d.by, decidedAt: new Date(), reason: d.reason ?? null, comments: d.comments ?? [], reauthenticated: !!d.reauthenticated, updatedAt: new Date() }).where(eq(t.gates.id, gateId));
    await this.audit(w.factoryId, d.by, 'gate.decided', w.shortId, { gateId, gate: g.type, decision: status, subjectHash: g.subjectHash, reason: d.reason ?? null, commentCount: d.comments?.length ?? 0, reauthenticated: !!d.reauthenticated, decidedByName: d.byName });
    await this.db.insert(t.messages).values({ id: ulid(), workItemId: w.id, authorKind: 'user', authorId: d.by, authorName: d.byName ?? null, body: `${d.decision === 'approve' ? 'Approved' : 'Requested changes on'} ${g.type}${d.reason ? `: ${d.reason}` : ''}`, channel: 'web', meta: { gateId } });
    await this.applyEvent(w.id, d.decision === 'approve' ? { type: 'gate_approved', gate: g.type } : { type: 'gate_changes_requested', gate: g.type }, d.by);
    return (await this.db.select().from(t.gates).where(eq(t.gates.id, gateId)))[0];
  }

  /* ------------------------------------------------------------------ lifecycle actions by people */

  async markHandedOff(workItemId: string, by: string) {
    const w = await this.item(workItemId);
    if (w.state !== 'AWAITING_HANDOFF') throw conflict(`Work item is ${w.state}, not awaiting handoff`);
    await this.audit(w.factoryId, by, 'handoff.confirmed', w.shortId, { prUrl: w.prUrl });
    return this.applyEvent(workItemId, { type: 'handed_off' }, by);
  }
  async prClosed(workItemId: string, merged: boolean, by = 'forge') {
    await this.audit((await this.item(workItemId)).factoryId, by, 'pr.closed', workItemId, { merged });
    return this.applyEvent(workItemId, { type: 'pr_closed', merged }, by);
  }
  async cancelWorkItem(workItemId: string, by: string) {
    return this.applyEvent(workItemId, { type: 'cancel' }, by);
  }
  async retryWorkItem(workItemId: string, by: string) {
    return this.applyEvent(workItemId, { type: 'retry' }, by);
  }

  /** Run one agent against a sample request without involving the state machine (Agent editor 'test run'). */
  async testRun(factoryId: string, agentName: string, sample: { title: string; body: string }, by: string): Promise<{ workItemId: string; runId: string }> {
    const active = await this.d.defs.getActive(factoryId);
    const agent = active?.agents.get(agentName);
    if (!active || !agent) throw notFound('Agent', agentName);
    const { shortId, seq } = await nextShortId(this.db, factoryId);
    const id = ulid();
    const repo = (await this.db.select().from(t.repositories).where(eq(t.repositories.factoryId, factoryId)).orderBy(asc(t.repositories.createdAt)).limit(1))[0];
    await this.db.insert(t.workItems).values({ id, factoryId, shortId, seq, title: `[test] ${sample.title}`, body: sample.body, sourceType: 'test', state: agent.fm.phase === 'CUSTOM' ? 'INTENT' : agent.fm.phase, phase: agent.fm.phase === 'CUSTOM' ? 'INTENT' : agent.fm.phase, repoId: repo?.id ?? null, branch: `zerovity/test-${shortId.toLowerCase()}`, requesterId: by, budgetUsd: 5, flags: { test: true } });
    await this.audit(factoryId, by, 'agent.test_run', shortId, { agent: agentName });
    const runId = await this.enqueueRun(id, (agent.fm.phase === 'CUSTOM' ? 'INTENT' : agent.fm.phase) as Phase, 'start', false, agentName);
    if (!runId) throw conflict('Could not queue the test run');
    return { workItemId: id, runId };
  }

  /** A person sends a message into an agent's session: delivered live if the run is active, otherwise as a new follow-up run. */
  async followup(runId: string, message: string, by: string): Promise<{ mode: 'live' | 'queued'; runId: string }> {
    const [r] = await this.db.select().from(t.runs).where(eq(t.runs.id, runId));
    if (!r) throw notFound('Run', runId);
    const w = await this.item(r.workItemId);
    await this.audit(w.factoryId, by, 'run.followup', w.shortId, { runId, messageHash: sha(message) });
    if (r.status === 'running') {
      const [row] = await this.db.select().from(t.kv).where(eq(t.kv.key, `followup:${runId}`));
      await this.db.insert(t.kv).values({ key: `followup:${runId}`, value: [...((row?.value as string[]) ?? []), message] }).onConflictDoUpdate({ target: t.kv.key, set: { value: [...((row?.value as string[]) ?? []), message] } });
      return { mode: 'live', runId };
    }
    const id = ulid();
    await this.db.insert(t.runs).values({ id, workItemId: r.workItemId, factoryId: r.factoryId, agentName: r.agentName, phase: r.phase, harness: r.harness, model: r.model, runner: r.runner, status: 'queued', kind: 'followup', attempt: r.attempt, definitionVersionId: r.definitionVersionId });
    await this.d.queue.enqueue(RUN_QUEUE, { runId: id, reason: 'followup', resume: true, message }, { singletonKey: `run:${id}`, maxAttempts: 1 });
    await this.db.insert(t.messages).values({ id: ulid(), workItemId: w.id, authorKind: 'user', authorId: by, body: `Follow-up to ${r.agentName}: ${message}`, channel: 'web', meta: { runId: id } });
    this.touch(w.factoryId, { workItemId: w.id, runId: id });
    return { mode: 'queued', runId: id };
  }

  /** Stop one run without cancelling the work item (the stop button on the live run view). */
  async stopRun(runId: string, by: string): Promise<void> {
    const [r] = await this.db.select().from(t.runs).where(eq(t.runs.id, runId));
    if (!r) throw notFound('Run', runId);
    await this.audit(r.factoryId, by, 'run.stop_requested', r.id, {});
    if (r.status === 'queued') await this.finishRun(runId, { status: 'cancelled', exitReason: 'stopped' }).catch(() => undefined);
    else await this.db.insert(t.kv).values({ key: `cancel:${runId}`, value: true }).onConflictDoNothing();
  }

  /* ------------------------------------------------------------------ foreman voice and the source thread */

  /** The only component that talks to the requester (spec 10.2). */
  async say(w: WorkItemRow, kind: string, text: string): Promise<void> {
    await this.db.insert(t.messages).values({ id: ulid(), workItemId: w.id, authorKind: 'foreman', authorName: 'Foreman', body: text, channel: w.sourceType === 'web' ? 'web' : w.sourceType, meta: { kind } });
    this.touch(w.factoryId, { workItemId: w.id });
    if (w.sourceType !== 'web' && this.d.notifier) {
      try { await this.d.notifier.send({ workItem: w, factoryId: w.factoryId, kind, text }); } catch (e) { this.log.warn('notifier failed', { workItemId: w.id, error: errMessage(e) }); }
    }
  }

  private async postSource(w: WorkItemRow, kind: string): Promise<void> {
    const active = await this.d.defs.getActive(w.factoryId);
    const prLine = w.prUrl ? ` ${w.prUrl}` : '';
    switch (kind) {
      case 'started': return this.say(w, kind, `${w.shortId} started. I'll work it through ${w.state.toLowerCase()} first, and I'll ask here if anything is unclear.`);
      case 'spec_ready': return this.say(w, kind, `The spec for ${w.shortId} is ready for approval.${prLine} A person with the approver role needs to approve it before any code is written.`);
      case 'gate': { const s = w.state; return this.say(w, kind, s === 'AWAITING_GATE' ? `${w.shortId} is waiting on the "${w.gate}" approval before it continues.` : `Spec approved for ${w.shortId}; the build starts now.`); }
      case 'revision': return this.say(w, kind, `Verification found issues on ${w.shortId}. The executor is revising (loop ${w.loops} of ${active?.policy.maxRevisionLoops ?? 3}).`);
      case 'verify_done': { const r = await this.latestRun(w.id, 'VERIFY'); const rec = (r?.resultJson as RunResult | null)?.recommendation; if (rec === 'escalate' || w.loops >= (active?.policy.maxRevisionLoops ?? 3)) return this.say(w, kind, `Verification of ${w.shortId} finished with recommendation: ${rec ?? 'escalate'}. A person should look closely at the handoff.`); return; }
      case 'handoff': return this.handoffMessage(w);
      case 'blocked': { const last = (await this.db.select().from(t.runs).where(eq(t.runs.workItemId, w.id)).orderBy(desc(t.runs.createdAt)).limit(1))[0]; return this.say(w, kind, `${w.shortId} is blocked${last?.exitReason ? ` (${last.exitReason})` : ''}. A person needs to look at it.`); }
      case 'completed': return this.say(w, kind, `${w.shortId} is complete.`);
      case 'cancelled': return this.say(w, kind, `${w.shortId} was cancelled.`);
      case 'questions': return; // already posted with the rewritten questions
    }
  }

  private async handoffMessage(w: WorkItemRow) {
    await this.finalizePr(w).catch((e) => this.log.warn('finalize pr failed', { error: errMessage(e) }));
    const fresh = await this.item(w.id);
    const ver = await this.latestRun(w.id, 'VERIFY');
    const r = ver?.resultJson as RunResult | null;
    const flags: string[] = [];
    const fl = fresh.flags as { escalated?: boolean; loopLimitHit?: boolean };
    if (fl.escalated) flags.push('verification escalated to a person');
    if (fl.loopLimitHit) flags.push('revision limit reached with open findings');
    const dec = await this.d.advisor.summariseHandoff({ title: w.title, recommendation: r?.recommendation, findings: r?.findings ?? [], summary: r?.summary, flags, prUrl: fresh.prUrl });
    await this.audit(w.factoryId, `foreman:${this.d.advisor.name}`, 'foreman.decision', w.shortId, { decision: 'handoff_summary', output: dec.value, source: dec.source, fallbackReason: dec.fallbackReason });
    await this.say(fresh, 'handoff', dec.value.message);
  }

  /* ------------------------------------------------------------------ PRs */

  private async forgeFor(w: WorkItemRow): Promise<{ forge: Forge; repo: RepoRow } | undefined> {
    const repo = await this.repoOf(w);
    if (!repo) return undefined;
    const forge = (await this.d.forges?.forRepo(w.factoryId, repo)) ?? localForge;
    return { forge, repo };
  }

  async openDraftPr(workItemId: string): Promise<{ url: string; number: number } | undefined> {
    const w = await this.item(workItemId);
    if (w.prUrl) return { url: w.prUrl, number: w.prNumber ?? 0 };
    const x = await this.forgeFor(w);
    if (!x) return undefined;
    const spec = (await this.specText(w.id)) ?? '';
    const body = `Work item **${w.shortId}**${w.sourceUrl ? ` · source: ${w.sourceUrl}` : ''}\n\n${spec ? spec.slice(0, 6000) : 'Spec in progress.'}\n\n---\n_Opened by Zerovity Factory. Agents never merge: a person decides._`;
    const pr = await x.forge.openPullRequest({ owner: x.repo.owner, name: x.repo.name, head: w.branch ?? '', base: x.repo.defaultBranch, title: `[${w.shortId}] ${w.title}`, body, draft: true });
    await this.db.update(t.workItems).set({ prUrl: pr.url, prNumber: pr.number, updatedAt: new Date() }).where(eq(t.workItems.id, w.id));
    await this.audit(w.factoryId, 'system', 'pr.opened', w.shortId, { url: pr.url, number: pr.number, draft: true });
    return { url: pr.url, number: pr.number };
  }

  private async finalizePr(w: WorkItemRow) {
    if (!w.prNumber) return;
    const x = await this.forgeFor(w);
    if (!x) return;
    const ship = await this.latestRun(w.id, 'SHIP');
    const desc = ship ? await this.artifactText(ship.id, 'pr-description.md') : undefined;
    await x.forge.updatePullRequest(x.repo.owner, x.repo.name, w.prNumber, { ...(desc ? { body: desc } : {}), draft: false });
    await this.audit(w.factoryId, 'system', 'pr.ready', w.shortId, { number: w.prNumber });
  }

  /* ------------------------------------------------------------------ inbox for machine actions */

  private async createInbox(w: WorkItemRow, f: FactoryRow, kind: string, ref: string, _cause: MEvent): Promise<void> {
    const base = { orgId: f.orgId, factoryId: f.id, workItemId: w.id, refKey: ref };
    if (ref === 'q:budget') return; // created with the question
    if (kind === 'spec_approval' || kind === 'gate') {
      const g = await this.pendingGate(w.id);
      const spec = kind === 'spec_approval' ? await this.specText(w.id) : undefined;
      const run = await this.latestRun(w.id, kind === 'spec_approval' ? 'SPEC' : w.gate === 'dbReview' ? 'VERIFY' : 'BUILD');
      await this.inbox.create({ ...base, kind, title: kind === 'spec_approval' ? `${w.shortId} · Spec approval: ${w.title}` : `${w.shortId} · ${w.gate} approval`, body: (run?.resultJson as RunResult | null)?.summary ?? '', payload: { gateId: g?.id, gate: g?.type, prUrl: w.prUrl, specExcerpt: spec?.slice(0, 1200), runId: run?.id } });
      return;
    }
    if (kind === 'pr_review') {
      const ship = await this.latestRun(w.id, 'SHIP');
      await this.inbox.create({ ...base, kind, title: `${w.shortId} · Ready for review: ${w.title}`, body: (ship?.resultJson as RunResult | null)?.summary ?? 'Verification is complete and the pull request is ready for a person.', payload: { prUrl: w.prUrl, flags: w.flags } });
      return;
    }
    if (kind === 'blocked' || kind === 'failed') {
      const last = (await this.db.select().from(t.runs).where(eq(t.runs.workItemId, w.id)).orderBy(desc(t.runs.createdAt)).limit(1))[0];
      const [errEv] = last ? await this.db.select().from(t.runEvents).where(and(eq(t.runEvents.runId, last.id), eq(t.runEvents.kind, 'error'))).orderBy(desc(t.runEvents.seq)).limit(1) : [];
      const why = (errEv?.payload as { message?: string } | undefined)?.message;
      await this.inbox.create({ ...base, kind, title: `${w.shortId} · ${kind === 'failed' ? 'Run failed' : 'Blocked'}: ${w.title}`, body: why ?? (last?.resultJson as RunResult | null)?.summary ?? last?.exitReason ?? 'A person needs to look at this work item.', payload: { runId: last?.id, exitReason: last?.exitReason, error: why } });
      return;
    }
    await this.inbox.create({ ...base, kind, title: `${w.shortId} · ${w.title}` });
  }

  /* ------------------------------------------------------------------ periodic and recovery */

  /** Reminders and timeouts for unanswered questions (spec 6.3 questionTimeoutHours). Call about every minute. */
  async tick(now = new Date()): Promise<{ reminded: number; blocked: number; reaped: number; failedRuns: number }> {
    const out = { reminded: 0, blocked: 0, reaped: 0, failedRuns: 0 };
    out.reaped = await this.d.queue.reapExpired();
    out.failedRuns = await this.reconcile(0); // runs whose worker stopped heartbeating
    const waiting = await this.db.select().from(t.workItems).where(eq(t.workItems.state, 'NEEDS_INPUT'));
    for (const w of waiting) {
      const active = await this.d.defs.getActive(w.factoryId);
      const hours = active?.policy.questionTimeoutHours ?? 48;
      const age = (now.getTime() - w.stateSince.getTime()) / 3_600_000;
      const f = await this.factory(w.factoryId);
      const flags = w.flags as { reminded?: boolean };
      if (age >= hours * 2) { await this.applyEvent(w.id, { type: 'question_timeout' }, 'system'); out.blocked++; }
      else if (age >= hours && !flags.reminded) {
        await this.db.update(t.workItems).set({ flags: { ...w.flags, reminded: true } }).where(eq(t.workItems.id, w.id));
        await this.inbox.create({ orgId: f.orgId, factoryId: f.id, workItemId: w.id, kind: 'question', title: `${w.shortId} · Reminder: still waiting for an answer`, body: `Unanswered for ${Math.floor(age)} hours. It will be marked blocked after ${hours * 2} hours.`, refKey: 'q:reminder' });
        await this.say(w, 'questions', `Reminder: ${w.shortId} has been waiting for an answer for ${Math.floor(age)} hours.`);
        out.reminded++;
      }
    }
    return out;
  }

  /**
   * Runs left 'running' by a dead process are failed so the machine can retry them. A run whose job is still locked by a live
   * worker (the lock is extended by heartbeats) is NOT lost, however long it has been running: with several workers a newly
   * started one must never fail the others' runs. Use ignoreLocks only when this process is the only worker (embedded mode).
   */
  async reconcile(maxAgeMinutes = 0, o: { ignoreLocks?: boolean } = {}): Promise<number> {
    const rows = await this.db.select().from(t.runs).where(eq(t.runs.status, 'running'));
    let n = 0;
    for (const r of rows) {
      if (maxAgeMinutes && r.startedAt && Date.now() - r.startedAt.getTime() < maxAgeMinutes * 60_000) continue;
      if (!o.ignoreLocks) {
        const [live] = await this.db.select({ id: t.jobs.id }).from(t.jobs).where(and(eq(t.jobs.queue, RUN_QUEUE), eq(t.jobs.state, 'active'), gt(t.jobs.lockedUntil, new Date()), sql`(${t.jobs.payload})->>'runId' = ${r.id}`)).limit(1);
        if (live) continue;
      }
      await this.finishRun(r.id, { status: 'failed', exitReason: 'worker_lost' });
      n++;
    }
    return n;
  }
}

const localForge = new LocalForge();
export type { ActiveDefinition, Issue };
export { initialState };

import type { InboxKind, Phase, WorkState } from '@zerovity/core';
import type { Policy, TriageInfo } from './policy';

/**
 * The work item state machine (spec 10.1) as a pure function: next(state, event, policy) -> { state, actions }.
 * It never touches the database or a clock, so every transition is replayable and exhaustively testable.
 */

export interface MState {
  state: WorkState;
  /** state to return to after NEEDS_INPUT or BLOCKED */
  pausedState?: WorkState;
  /** AWAITING_GATE: the gate waiting on a person, the gates queued behind it, and where to go afterwards */
  gate?: string;
  gateQueue: string[];
  gateNext?: WorkState;
  loops: number;
  failures: number;
  triage?: TriageInfo;
  paths: string[];
  flags: { escalated?: boolean; loopLimitHit?: boolean; budgetBlocked?: boolean };
}

export type StepOutcome = { triage?: TriageInfo; recommendation?: 'accept' | 'revise' | 'escalate'; pathsTouched?: string[] };

export type MEvent =
  | { type: 'created'; startAt?: 'INTENT' | 'SPEC' | 'BUILD' }
  | { type: 'run_done'; result?: StepOutcome }
  | { type: 'run_needs_input' }
  | { type: 'run_blocked' }
  | { type: 'run_failed' }
  | { type: 'budget_exceeded' }
  | { type: 'questions_answered' }
  | { type: 'question_timeout' }
  | { type: 'gate_approved'; gate: string }
  | { type: 'gate_changes_requested'; gate: string }
  | { type: 'handed_off' }
  | { type: 'pr_closed'; merged?: boolean }
  | { type: 'retry' }
  | { type: 'fatal' }
  | { type: 'cancel' };

export type DispatchReason = 'start' | 'next_phase' | 'resume_answers' | 'revision' | 'changes_requested' | 'retry';

export type Action =
  | { type: 'dispatchRun'; phase: Phase; reason: DispatchReason; resume: boolean }
  | { type: 'createInbox'; kind: InboxKind; ref: string }
  | { type: 'resolveInbox'; refPrefix: string }
  | { type: 'requestGate'; gate: string }
  | { type: 'postSource'; kind: 'started' | 'questions' | 'spec_ready' | 'gate' | 'verify_done' | 'handoff' | 'blocked' | 'completed' | 'cancelled' | 'revision' }
  | { type: 'openDraftPr' }
  | { type: 'cancelRuns' }
  | { type: 'complete' };

export interface Step { state: MState; actions: Action[]; ignored: boolean; label: string }

export const RUNNING = ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'] as const;
export type RunningState = (typeof RUNNING)[number];
export const isRunning = (s: WorkState): s is RunningState => (RUNNING as readonly string[]).includes(s);
export const TERMINAL: WorkState[] = ['COMPLETE', 'CANCELLED', 'FAILED'];

export const initialState = (): MState => ({ state: 'INTAKE', gateQueue: [], loops: 0, failures: 0, paths: [], flags: {} });

const keep = (s: MState, label: string): Step => ({ state: s, actions: [], ignored: true, label: `ignored:${label}` });

export function next(s: MState, e: MEvent, policy: Policy): Step {
  const done = (state: MState, actions: Action[], label: string): Step => ({ state, actions, ignored: false, label });
  const st = s.state;

  if (TERMINAL.includes(st)) return keep(s, `${st}/${e.type}`);

  if (e.type === 'cancel') return done({ ...s, state: 'CANCELLED', gate: undefined, gateQueue: [], pausedState: undefined }, [{ type: 'cancelRuns' }, { type: 'resolveInbox', refPrefix: '' }, { type: 'postSource', kind: 'cancelled' }], 'cancel');
  if (e.type === 'fatal') return done({ ...s, state: 'FAILED' }, [{ type: 'cancelRuns' }, { type: 'createInbox', kind: 'failed', ref: 'fatal' }, { type: 'postSource', kind: 'blocked' }], 'fatal');

  switch (st) {
    case 'INTAKE': {
      if (e.type !== 'created') return keep(s, `INTAKE/${e.type}`);
      const at = e.startAt ?? 'INTENT';
      return done({ ...s, state: at }, [{ type: 'postSource', kind: 'started' }, { type: 'dispatchRun', phase: at, reason: 'start', resume: false }], `intake->${at}`);
    }

    case 'INTENT':
    case 'SPEC':
    case 'BUILD':
    case 'VERIFY':
    case 'SHIP':
      return running(s, st, e, policy, done);

    case 'NEEDS_INPUT': {
      if (e.type === 'question_timeout')
        return done({ ...s, state: 'BLOCKED' }, [{ type: 'createInbox', kind: 'blocked', ref: 'blocked' }, { type: 'postSource', kind: 'blocked' }], 'question_timeout->BLOCKED');
      if (e.type !== 'questions_answered') return keep(s, `NEEDS_INPUT/${e.type}`);
      const back = s.pausedState && isRunning(s.pausedState) ? s.pausedState : 'INTENT';
      return done({ ...s, state: back, pausedState: undefined, flags: { ...s.flags, budgetBlocked: false } }, [{ type: 'resolveInbox', refPrefix: 'q:' }, { type: 'dispatchRun', phase: back, reason: 'resume_answers', resume: true }], `answers->${back}`);
    }

    case 'AWAITING_SPEC_APPROVAL': {
      if (e.type === 'gate_approved' && e.gate === 'specApproval')
        return done({ ...s, state: 'BUILD' }, [{ type: 'resolveInbox', refPrefix: 'gate:specApproval' }, { type: 'dispatchRun', phase: 'BUILD', reason: 'next_phase', resume: false }, { type: 'postSource', kind: 'gate' }], 'spec-approved->BUILD');
      if (e.type === 'gate_changes_requested' && e.gate === 'specApproval')
        return done({ ...s, state: 'SPEC' }, [{ type: 'resolveInbox', refPrefix: 'gate:specApproval' }, { type: 'dispatchRun', phase: 'SPEC', reason: 'changes_requested', resume: true }, { type: 'postSource', kind: 'revision' }], 'spec-changes->SPEC');
      return keep(s, `AWAITING_SPEC_APPROVAL/${e.type}`);
    }

    case 'AWAITING_GATE': {
      if (!s.gate) return keep(s, 'AWAITING_GATE/no-gate');
      if (e.type === 'gate_approved' && e.gate === s.gate) {
        const resolve: Action = { type: 'resolveInbox', refPrefix: `gate:${s.gate}` };
        if (s.gateQueue.length) {
          const [g, ...rest] = s.gateQueue;
          return done({ ...s, gate: g, gateQueue: rest }, [resolve, { type: 'requestGate', gate: g }, { type: 'createInbox', kind: 'gate', ref: `gate:${g}` }], `gate:${s.gate}->gate:${g}`);
        }
        const to = s.gateNext ?? 'VERIFY';
        const acts: Action[] = [resolve];
        if (isRunning(to)) acts.push({ type: 'dispatchRun', phase: to, reason: 'next_phase', resume: false });
        return done({ ...s, state: to, gate: undefined, gateNext: undefined }, acts, `gate:${s.gate}->${to}`);
      }
      if (e.type === 'gate_changes_requested' && e.gate === s.gate)
        return done({ ...s, state: 'BUILD', gate: undefined, gateQueue: [], gateNext: undefined, loops: s.loops + 1 }, [{ type: 'resolveInbox', refPrefix: `gate:${s.gate}` }, { type: 'dispatchRun', phase: 'BUILD', reason: 'changes_requested', resume: true }, { type: 'postSource', kind: 'revision' }], `gate:${s.gate}-changes->BUILD`);
      return keep(s, `AWAITING_GATE/${e.type}`);
    }

    case 'AWAITING_HANDOFF': {
      if (e.type === 'handed_off' || e.type === 'pr_closed')
        return done({ ...s, state: 'COMPLETE' }, [{ type: 'resolveInbox', refPrefix: 'handoff' }, { type: 'complete' }, { type: 'postSource', kind: 'completed' }], e.type === 'handed_off' ? 'handoff->COMPLETE' : 'pr_closed->COMPLETE');
      return keep(s, `AWAITING_HANDOFF/${e.type}`);
    }

    case 'BLOCKED': {
      if (e.type !== 'retry') return keep(s, `BLOCKED/${e.type}`);
      const back = s.pausedState && isRunning(s.pausedState) ? s.pausedState : 'INTENT';
      return done({ ...s, state: back, pausedState: undefined, failures: 0 }, [{ type: 'resolveInbox', refPrefix: 'blocked' }, { type: 'dispatchRun', phase: back, reason: 'retry', resume: true }], `retry->${back}`);
    }
  }
  return keep(s, `${st}/${e.type}`);
}

function running(s: MState, st: RunningState, e: MEvent, policy: Policy, done: (state: MState, actions: Action[], label: string) => Step): Step {
  switch (e.type) {
    case 'run_needs_input':
      return done({ ...s, state: 'NEEDS_INPUT', pausedState: st, failures: 0 }, [{ type: 'postSource', kind: 'questions' }], `${st}:needs_input`);
    case 'budget_exceeded':
      return done({ ...s, state: 'NEEDS_INPUT', pausedState: st, flags: { ...s.flags, budgetBlocked: true } }, [{ type: 'createInbox', kind: 'question', ref: 'q:budget' }, { type: 'postSource', kind: 'questions' }], `${st}:budget`);
    case 'run_blocked':
      return done({ ...s, state: 'BLOCKED', pausedState: st }, [{ type: 'createInbox', kind: 'blocked', ref: 'blocked' }, { type: 'postSource', kind: 'blocked' }], `${st}:blocked`);
    case 'run_failed': {
      const failures = s.failures + 1;
      if (failures >= policy.maxConsecutiveFailures)
        return done({ ...s, state: 'BLOCKED', pausedState: st, failures }, [{ type: 'createInbox', kind: 'failed', ref: 'blocked' }, { type: 'postSource', kind: 'blocked' }], `${st}:failed-twice->BLOCKED`);
      return done({ ...s, failures }, [{ type: 'dispatchRun', phase: st, reason: 'retry', resume: true }], `${st}:failed-retry`);
    }
    case 'run_done':
      return runDone(s, st, e.result ?? {}, policy, done);
    default:
      return keep(s, `${st}/${e.type}`);
  }
}

function runDone(s0: MState, st: RunningState, r: StepOutcome, policy: Policy, done: (state: MState, actions: Action[], label: string) => Step): Step {
  const s: MState = { ...s0, failures: 0, triage: r.triage ?? s0.triage, paths: [...new Set([...s0.paths, ...(r.pathsTouched ?? [])])] };
  const ctx = { triage: s.triage, paths: s.paths };
  const gateStep = (phase: Phase, after: WorkState, extra: Action[], label: string): Step | undefined => {
    const gates = policy.extraGatesAfter(phase, ctx);
    if (!gates.length) return undefined;
    const [g, ...rest] = gates.map((x) => x.name);
    return done({ ...s, state: 'AWAITING_GATE', gate: g, gateQueue: rest, gateNext: after }, [...extra, { type: 'requestGate', gate: g }, { type: 'createInbox', kind: 'gate', ref: `gate:${g}` }, { type: 'postSource', kind: 'gate' }], `${label}->gate:${g}`);
  };

  switch (st) {
    case 'INTENT': {
      if (s.triage?.skipSpec) return done({ ...s, state: 'BUILD' }, [{ type: 'dispatchRun', phase: 'BUILD', reason: 'next_phase', resume: false }], 'INTENT:skipSpec->BUILD');
      return done({ ...s, state: 'SPEC' }, [{ type: 'dispatchRun', phase: 'SPEC', reason: 'next_phase', resume: false }], 'INTENT->SPEC');
    }
    case 'SPEC': {
      if (policy.specApproval)
        return done({ ...s, state: 'AWAITING_SPEC_APPROVAL' }, [{ type: 'openDraftPr' }, { type: 'requestGate', gate: 'specApproval' }, { type: 'createInbox', kind: 'spec_approval', ref: 'gate:specApproval' }, { type: 'postSource', kind: 'spec_ready' }], 'SPEC->AWAITING_SPEC_APPROVAL');
      return done({ ...s, state: 'BUILD' }, [{ type: 'openDraftPr' }, { type: 'dispatchRun', phase: 'BUILD', reason: 'next_phase', resume: false }], 'SPEC->BUILD');
    }
    case 'BUILD': {
      const g = gateStep('BUILD', 'VERIFY', [], 'BUILD');
      if (g) return g;
      return done({ ...s, state: 'VERIFY' }, [{ type: 'dispatchRun', phase: 'VERIFY', reason: 'next_phase', resume: false }], 'BUILD->VERIFY');
    }
    case 'VERIFY': {
      const rec = r.recommendation ?? 'escalate';
      if (rec === 'revise' && s.loops < policy.maxRevisionLoops)
        return done({ ...s, state: 'BUILD', loops: s.loops + 1 }, [{ type: 'postSource', kind: 'revision' }, { type: 'dispatchRun', phase: 'BUILD', reason: 'revision', resume: true }], 'VERIFY:revise->BUILD');
      const flags = { ...s.flags, escalated: rec === 'escalate' || s.flags.escalated, loopLimitHit: rec === 'revise' || s.flags.loopLimitHit };
      const base = { ...s, flags };
      const verifyNote: Action = { type: 'postSource', kind: 'verify_done' };
      const g = ((): Step | undefined => {
        const gates = policy.extraGatesAfter('VERIFY', ctx);
        if (!gates.length) return undefined;
        const [first, ...rest] = gates.map((x) => x.name);
        return done({ ...base, state: 'AWAITING_GATE', gate: first, gateQueue: rest, gateNext: 'SHIP' }, [verifyNote, { type: 'requestGate', gate: first }, { type: 'createInbox', kind: 'gate', ref: `gate:${first}` }], `VERIFY:${rec}->gate:${first}`);
      })();
      if (g) return g;
      return done({ ...base, state: 'SHIP' }, [verifyNote, { type: 'dispatchRun', phase: 'SHIP', reason: 'next_phase', resume: false }], `VERIFY:${rec}->SHIP`);
    }
    case 'SHIP': {
      if (!policy.handoffRequired) return done({ ...s, state: 'COMPLETE' }, [{ type: 'complete' }, { type: 'postSource', kind: 'completed' }], 'SHIP->COMPLETE');
      return done({ ...s, state: 'AWAITING_HANDOFF' }, [{ type: 'createInbox', kind: 'pr_review', ref: 'handoff' }, { type: 'postSource', kind: 'handoff' }], 'SHIP->AWAITING_HANDOFF');
    }
  }
}

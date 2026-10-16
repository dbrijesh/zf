import { describe, it, expect } from 'vitest';
import { WORK_STATES, type WorkState } from '@zerovity/core';
import { GatesFileSchema } from '@zerovity/definition';
import { next, initialState, isRunning, type MEvent, type MState, type Action } from '../src/machine';
import { policyFromGates } from '../src/policy';

const policy = (g: unknown = {}) => policyFromGates(GatesFileSchema.parse(g));
const withSpecGate = policy({ gates: { specApproval: { phase: 'SPEC', required: true } } });
const noGates = policy({});
const st = (state: WorkState, extra: Partial<MState> = {}): MState => ({ ...initialState(), state, ...extra });
const acts = (a: Action[]) => a.map((x) => (x.type === 'dispatchRun' ? `dispatch:${x.phase}:${x.reason}${x.resume ? ':resume' : ''}` : x.type === 'createInbox' ? `inbox:${x.kind}` : x.type === 'postSource' ? `post:${x.kind}` : x.type === 'requestGate' ? `gate:${x.gate}` : x.type));

const EVENTS: MEvent[] = [
  { type: 'created' }, { type: 'run_done' }, { type: 'run_needs_input' }, { type: 'run_blocked' }, { type: 'run_failed' }, { type: 'budget_exceeded' }, { type: 'questions_answered' }, { type: 'question_timeout' }, { type: 'question_timeout' },
  { type: 'gate_approved', gate: 'specApproval' }, { type: 'gate_changes_requested', gate: 'specApproval' }, { type: 'handed_off' }, { type: 'pr_closed' }, { type: 'retry' }, { type: 'fatal' }, { type: 'cancel' },
];

/** every (state, event) pair that is allowed to do something; everything else must be ignored */
const VALID: Record<string, WorkState[]> = {
  created: ['INTAKE'],
  run_done: ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'],
  run_needs_input: ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'],
  run_blocked: ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'],
  run_failed: ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'],
  budget_exceeded: ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'],
  questions_answered: ['NEEDS_INPUT'],
  question_timeout: ['NEEDS_INPUT'],
  gate_approved: ['AWAITING_SPEC_APPROVAL', 'AWAITING_GATE'],
  gate_changes_requested: ['AWAITING_SPEC_APPROVAL', 'AWAITING_GATE'],
  handed_off: ['AWAITING_HANDOFF'],
  pr_closed: ['AWAITING_HANDOFF'],
  retry: ['BLOCKED'],
  fatal: ['INTAKE', 'INTENT', 'SPEC', 'AWAITING_SPEC_APPROVAL', 'BUILD', 'VERIFY', 'AWAITING_GATE', 'SHIP', 'AWAITING_HANDOFF', 'NEEDS_INPUT', 'BLOCKED'],
  cancel: ['INTAKE', 'INTENT', 'SPEC', 'AWAITING_SPEC_APPROVAL', 'BUILD', 'VERIFY', 'AWAITING_GATE', 'SHIP', 'AWAITING_HANDOFF', 'NEEDS_INPUT', 'BLOCKED'],
};

describe('transition matrix is exhaustive', () => {
  for (const state of WORK_STATES) {
    for (const e of EVENTS) {
      const valid = VALID[e.type].includes(state);
      it(`${state} + ${e.type} -> ${valid ? 'acts' : 'ignored'}`, () => {
        const base = st(state, state === 'AWAITING_GATE' ? { gate: 'specApproval', gateNext: 'VERIFY' } : {});
        const r = next(base, e, withSpecGate);
        // a gate event with the wrong gate name is ignored even in a gate state; the matrix uses a matching name
        if (valid) {
          expect(r.ignored).toBe(false);
          expect(r.actions.length + (r.state.state !== state ? 1 : 0)).toBeGreaterThan(0);
        } else {
          expect(r.ignored).toBe(true);
          expect(r.state).toEqual(base);
          expect(r.actions).toEqual([]);
        }
      });
    }
  }
  it('next never mutates its input', () => {
    const s = st('BUILD', { paths: ['a'] });
    const frozen = JSON.stringify(s);
    next(s, { type: 'run_done', result: { pathsTouched: ['b'] } }, noGates);
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe('happy path (spec 10.1)', () => {
  it('INTAKE -> INTENT -> SPEC -> AWAITING_SPEC_APPROVAL -> BUILD -> VERIFY -> SHIP -> AWAITING_HANDOFF -> COMPLETE', () => {
    let s = initialState();
    const trail: string[] = [];
    const go = (e: MEvent, p = withSpecGate) => { const r = next(s, e, p); s = r.state; trail.push(`${r.state.state}[${acts(r.actions).join(',')}]`); return r; };
    go({ type: 'created' });
    go({ type: 'run_done', result: { triage: { complexity: 'M', risk: 'low', skipSpec: false } } });
    go({ type: 'run_done' });
    go({ type: 'gate_approved', gate: 'specApproval' });
    go({ type: 'run_done' });
    go({ type: 'run_done', result: { recommendation: 'accept' } });
    go({ type: 'run_done' });
    go({ type: 'handed_off' });
    expect(trail).toEqual([
      'INTENT[post:started,dispatch:INTENT:start]',
      'SPEC[dispatch:SPEC:next_phase]',
      'AWAITING_SPEC_APPROVAL[openDraftPr,gate:specApproval,inbox:spec_approval,post:spec_ready]',
      'BUILD[resolveInbox,dispatch:BUILD:next_phase,post:gate]',
      'VERIFY[dispatch:VERIFY:next_phase]',
      'SHIP[post:verify_done,dispatch:SHIP:next_phase]',
      'AWAITING_HANDOFF[inbox:pr_review,post:handoff]',
      'COMPLETE[resolveInbox,complete,post:completed]',
    ]);
  });

  it('the foreman may start directly at SPEC or BUILD', () => {
    expect(next(initialState(), { type: 'created', startAt: 'BUILD' }, noGates).state.state).toBe('BUILD');
    expect(next(initialState(), { type: 'created', startAt: 'SPEC' }, noGates).state.state).toBe('SPEC');
  });

  it('skipSpec jumps INTENT -> BUILD', () => {
    expect(next(st('INTENT'), { type: 'run_done', result: { triage: { skipSpec: true } } }, withSpecGate).state.state).toBe('BUILD');
  });

  it('SPEC goes straight to BUILD when no approval gate is configured, still opening the draft PR', () => {
    const r = next(st('SPEC'), { type: 'run_done' }, noGates);
    expect(r.state.state).toBe('BUILD');
    expect(acts(r.actions)).toEqual(['openDraftPr', 'dispatch:BUILD:next_phase']);
  });

  it('a gate with required: false is treated as no gate', () => {
    expect(next(st('SPEC'), { type: 'run_done' }, policy({ gates: { specApproval: { phase: 'SPEC', required: false } } })).state.state).toBe('BUILD');
  });

  it('handoff.required=false completes right after SHIP', () => {
    const p = policy({ gates: { handoff: { required: false } } });
    expect(next(st('SHIP'), { type: 'run_done' }, p).state.state).toBe('COMPLETE');
  });

  it('a person marking handoff or the PR closing both complete the item', () => {
    expect(next(st('AWAITING_HANDOFF'), { type: 'pr_closed', merged: true }, noGates).state.state).toBe('COMPLETE');
  });
});

describe('questions (NEEDS_INPUT)', () => {
  for (const phase of ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'] as const) {
    it(`remembers ${phase} and resumes the same session when answered`, () => {
      const a = next(st(phase), { type: 'run_needs_input' }, noGates);
      expect(a.state).toMatchObject({ state: 'NEEDS_INPUT', pausedState: phase });
      expect(acts(a.actions)).toEqual(['post:questions']);
      const b = next(a.state, { type: 'questions_answered' }, noGates);
      expect(b.state.state).toBe(phase);
      expect(acts(b.actions)).toEqual(['resolveInbox', `dispatch:${phase}:resume_answers:resume`]);
    });
  }
  it('a budget stop asks a budget question and resumes after it is answered', () => {
    const a = next(st('BUILD'), { type: 'budget_exceeded' }, noGates);
    expect(a.state.flags.budgetBlocked).toBe(true);
    expect(acts(a.actions)).toContain('inbox:question');
    expect(next(a.state, { type: 'questions_answered' }, noGates).state.flags.budgetBlocked).toBe(false);
  });
  it('needs_input resets the failure counter', () => {
    expect(next(st('BUILD', { failures: 1 }), { type: 'run_needs_input' }, noGates).state.failures).toBe(0);
  });
});

describe('failures and blocking', () => {
  it('first failure retries the same phase; second consecutive failure blocks', () => {
    const a = next(st('BUILD'), { type: 'run_failed' }, noGates);
    expect(a.state).toMatchObject({ state: 'BUILD', failures: 1 });
    expect(acts(a.actions)).toEqual(['dispatch:BUILD:retry:resume']);
    const b = next(a.state, { type: 'run_failed' }, noGates);
    expect(b.state).toMatchObject({ state: 'BLOCKED', pausedState: 'BUILD' });
    expect(acts(b.actions)).toEqual(['inbox:failed', 'post:blocked']);
  });
  it('a success between failures resets the counter', () => {
    const a = next(st('BUILD'), { type: 'run_failed' }, noGates);
    const b = next(a.state, { type: 'run_done' }, noGates);
    expect(b.state.failures).toBe(0);
    expect(next(st('VERIFY', b.state), { type: 'run_failed' }, noGates).state.state).toBe('VERIFY');
  });
  it('an agent that reports blocked blocks immediately; retry returns to the paused phase', () => {
    const a = next(st('SPEC'), { type: 'run_blocked' }, noGates);
    expect(a.state.state).toBe('BLOCKED');
    const b = next(a.state, { type: 'retry' }, noGates);
    expect(b.state).toMatchObject({ state: 'SPEC', failures: 0 });
    expect(acts(b.actions)).toEqual(['resolveInbox', 'dispatch:SPEC:retry:resume']);
  });
  it('fatal moves to FAILED which is terminal', () => {
    const f = next(st('BUILD'), { type: 'fatal' }, noGates).state;
    expect(f.state).toBe('FAILED');
    expect(next(f, { type: 'retry' }, noGates).ignored).toBe(true);
  });
});

describe('verification loop (max 3, then handoff with a flag)', () => {
  it('revise sends the same executor session back to BUILD with the findings', () => {
    const r = next(st('VERIFY'), { type: 'run_done', result: { recommendation: 'revise' } }, noGates);
    expect(r.state).toMatchObject({ state: 'BUILD', loops: 1 });
    expect(acts(r.actions)).toEqual(['post:revision', 'dispatch:BUILD:revision:resume']);
  });
  it('after the limit the item moves on flagged instead of looping forever', () => {
    const r = next(st('VERIFY', { loops: 3 }), { type: 'run_done', result: { recommendation: 'revise' } }, noGates);
    expect(r.state.state).toBe('SHIP');
    expect(r.state.flags.loopLimitHit).toBe(true);
  });
  it('accept and escalate both proceed to SHIP; escalate is flagged; missing recommendation counts as escalate', () => {
    expect(next(st('VERIFY'), { type: 'run_done', result: { recommendation: 'accept' } }, noGates).state.flags.escalated).toBeFalsy();
    expect(next(st('VERIFY'), { type: 'run_done', result: { recommendation: 'escalate' } }, noGates).state.flags.escalated).toBe(true);
    expect(next(st('VERIFY'), { type: 'run_done' }, noGates).state.flags.escalated).toBe(true);
  });
  it('a custom maxRevisionLoops is honoured', () => {
    const p = policy({ gates: { maxRevisionLoops: 1 } });
    expect(next(st('VERIFY', { loops: 1 }), { type: 'run_done', result: { recommendation: 'revise' } }, p).state.state).toBe('SHIP');
  });
});

describe('spec approval gate', () => {
  it('changes requested goes back to SPEC resuming the writer session', () => {
    const s = st('AWAITING_SPEC_APPROVAL');
    const r = next(s, { type: 'gate_changes_requested', gate: 'specApproval' }, withSpecGate);
    expect(r.state.state).toBe('SPEC');
    expect(acts(r.actions)).toContain('dispatch:SPEC:changes_requested:resume');
  });
  it('ignores decisions for another gate', () => {
    expect(next(st('AWAITING_SPEC_APPROVAL'), { type: 'gate_approved', gate: 'buildApproval' }, withSpecGate).ignored).toBe(true);
  });
});

describe('risk-based extra gates (policies/gates.yaml riskOverrides)', () => {
  const p = policy({ gates: { riskOverrides: [{ if: 'triage.risk == "high"', add: ['buildApproval'] }, { if: 'paths.touched matches "migrations/**"', add: ['dbReview'] }] } });
  it('high risk adds buildApproval after BUILD, and approval continues to VERIFY', () => {
    const triaged = next(st('INTENT'), { type: 'run_done', result: { triage: { risk: 'high', skipSpec: true } } }, p).state;
    const g = next(triaged, { type: 'run_done' }, p);
    expect(g.state).toMatchObject({ state: 'AWAITING_GATE', gate: 'buildApproval', gateNext: 'VERIFY' });
    expect(acts(g.actions)).toEqual(['gate:buildApproval', 'inbox:gate', 'post:gate']);
    const ok = next(g.state, { type: 'gate_approved', gate: 'buildApproval' }, p);
    expect(ok.state.state).toBe('VERIFY');
    expect(acts(ok.actions)).toEqual(['resolveInbox', 'dispatch:VERIFY:next_phase']);
  });
  it('low risk does not add the gate', () => {
    expect(next(st('BUILD', { triage: { risk: 'low' } }), { type: 'run_done' }, p).state.state).toBe('VERIFY');
  });
  it('touching migrations adds dbReview after VERIFY, before SHIP', () => {
    const g = next(st('VERIFY', { paths: ['migrations/0001.sql'] }), { type: 'run_done', result: { recommendation: 'accept' } }, p);
    expect(g.state).toMatchObject({ state: 'AWAITING_GATE', gate: 'dbReview', gateNext: 'SHIP' });
    expect(next(g.state, { type: 'gate_approved', gate: 'dbReview' }, p).state.state).toBe('SHIP');
  });
  it('paths reported by the BUILD run count toward the policy', () => {
    const g = next(st('BUILD'), { type: 'run_done', result: { pathsTouched: ['migrations/x.sql'] } }, p);
    expect(g.state.paths).toContain('migrations/x.sql');
    expect(g.state.state).toBe('VERIFY'); // dbReview attaches to VERIFY, not BUILD
  });
  it('multiple gates after one phase are queued in order', () => {
    const both = policy({ gates: { dbReview: { phase: 'BUILD' }, riskOverrides: [{ if: 'triage.risk == "high"', add: ['buildApproval', 'dbReview'] }] } });
    const g = next(st('BUILD', { triage: { risk: 'high' } }), { type: 'run_done' }, both);
    expect(g.state).toMatchObject({ gate: 'buildApproval', gateQueue: ['dbReview'] });
    const g2 = next(g.state, { type: 'gate_approved', gate: 'buildApproval' }, both);
    expect(g2.state).toMatchObject({ state: 'AWAITING_GATE', gate: 'dbReview', gateQueue: [] });
    expect(next(g2.state, { type: 'gate_approved', gate: 'dbReview' }, both).state.state).toBe('VERIFY');
  });
  it('changes requested on a build gate sends the executor back to BUILD', () => {
    const g = next(st('BUILD', { triage: { risk: 'high' } }), { type: 'run_done' }, p);
    const r = next(g.state, { type: 'gate_changes_requested', gate: 'buildApproval' }, p);
    expect(r.state).toMatchObject({ state: 'BUILD', loops: 1 });
  });
});

describe('cancel', () => {
  it('cancels runs and resolves every inbox item for the work item', () => {
    const r = next(st('NEEDS_INPUT', { pausedState: 'SPEC' }), { type: 'cancel' }, noGates);
    expect(r.state.state).toBe('CANCELLED');
    expect(acts(r.actions)).toEqual(['cancelRuns', 'resolveInbox', 'post:cancelled']);
  });
  it('isRunning helper', () => {
    expect(isRunning('BUILD')).toBe(true);
    expect(isRunning('NEEDS_INPUT')).toBe(false);
  });
});

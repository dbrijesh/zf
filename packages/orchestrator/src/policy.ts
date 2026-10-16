import { evaluatePolicy, type GatesFile, type GateDef } from '@zerovity/definition';
import type { Phase } from '@zerovity/core';

export interface TriageInfo { risk?: 'low' | 'medium' | 'high'; complexity?: 'S' | 'M' | 'L'; skipSpec?: boolean }
export interface GateContext { triage?: TriageInfo; paths: string[] }

export interface GateRule { name: string; phase: Phase; required: boolean; approverGroups: string[]; approverUsers: string[]; requireReason: boolean; reauthenticate: boolean }

/** Gate behaviour as plain data, derived from policies/gates.yaml (spec 6.3). The state machine only sees this. */
export interface Policy {
  specApproval: GateRule | null;
  handoffRequired: boolean;
  maxRevisionLoops: number;
  maxConsecutiveFailures: number;
  questionTimeoutHours: number;
  /** extra gates required once `phase` completes, from riskOverrides evaluated against triage and touched paths */
  extraGatesAfter(phase: Phase, ctx: GateContext): GateRule[];
  gate(name: string): GateRule | undefined;
}

const BUILTIN: Record<string, { phase: Phase }> = { buildApproval: { phase: 'BUILD' }, dbReview: { phase: 'VERIFY' } };

export const DEFAULT_GATES = { gates: { questionTimeoutHours: 48, handoff: { required: true }, riskOverrides: [], maxRevisionLoops: 3 }, merge: { agentsMayMerge: false } } as unknown as GatesFile;

function rule(name: string, d: Omit<Partial<GateDef>, 'phase'> & { phase: Phase }): GateRule {
  return { name, phase: d.phase, required: d.required ?? true, approverGroups: d.approvers?.groups ?? [], approverUsers: d.approvers?.users ?? [], requireReason: d.requireReason ?? false, reauthenticate: d.reauthenticate ?? false };
}

export function policyFromGates(file: GatesFile = DEFAULT_GATES): Policy {
  const g = file.gates;
  const reserved = new Set(['questionTimeoutHours', 'handoff', 'riskOverrides', 'maxRevisionLoops']);
  const named = new Map<string, GateRule>();
  for (const [k, v] of Object.entries(g)) if (!reserved.has(k) && v && typeof v === 'object') named.set(k, rule(k, v as GateDef));
  for (const [k, b] of Object.entries(BUILTIN)) if (!named.has(k)) named.set(k, rule(k, { phase: b.phase }));
  const spec = g.specApproval ? rule('specApproval', g.specApproval) : null;
  if (spec && !spec.required) return build(null);
  return build(spec);

  function build(specApproval: GateRule | null): Policy {
    return {
      specApproval,
      handoffRequired: g.handoff.required,
      maxRevisionLoops: g.maxRevisionLoops,
      maxConsecutiveFailures: 2,
      questionTimeoutHours: g.questionTimeoutHours,
      gate: (n) => (n === 'specApproval' ? specApproval ?? undefined : named.get(n)),
      extraGatesAfter(phase, ctx) {
        const out: GateRule[] = [];
        const env = { triage: ctx.triage ?? {}, paths: { touched: ctx.paths } };
        for (const ro of g.riskOverrides) {
          const hit = (() => { try { return evaluatePolicy(ro.if, env); } catch { return false; } })();
          if (!hit) continue;
          for (const name of ro.add) {
            const r = named.get(name);
            if (r && r.phase === phase && r.required && !out.some((x) => x.name === name)) out.push(r);
          }
        }
        return out;
      },
    };
  }
}

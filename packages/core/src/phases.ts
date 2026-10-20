export const PHASES = ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'] as const;
export type Phase = (typeof PHASES)[number];
export const AGENT_PHASES = [...PHASES, 'CUSTOM'] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

/** Work item lifecycle states (spec 10.1). */
export const ACTIVE_STATES = [
  'INTAKE',
  'INTENT',
  'SPEC',
  'AWAITING_SPEC_APPROVAL',
  'BUILD',
  'VERIFY',
  'AWAITING_GATE',
  'SHIP',
  'AWAITING_HANDOFF',
  'NEEDS_INPUT',
] as const;
export const TERMINAL_STATES = ['COMPLETE', 'BLOCKED', 'FAILED', 'CANCELLED'] as const;
export const WORK_STATES = [...ACTIVE_STATES, ...TERMINAL_STATES] as const;
export type WorkState = (typeof WORK_STATES)[number];

/** States in which an agent run is the thing happening. */
export const RUNNING_STATES = ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'] as const;

export const isTerminal = (s: WorkState): boolean => (TERMINAL_STATES as readonly string[]).includes(s);
export const isActive = (s: WorkState): boolean => !isTerminal(s);

/** One accent per phase (design tokens in ui-kit use the same names). */
export const PHASE_VAR: Record<Phase | 'GATE', string> = {
  INTENT: '--intent',
  SPEC: '--spec',
  GATE: '--gate',
  BUILD: '--build',
  VERIFY: '--verify',
  SHIP: '--ship',
};

export const HARNESS_TYPES = ['claude-code', 'codex', 'copilot', 'cursor', 'fake'] as const;
export type HarnessType = (typeof HARNESS_TYPES)[number];
/** `fake` is a deterministic offline harness used for demos and tests. It is accepted by schemas but never shown as a production choice. */

export const ROLES = ['org_admin', 'factory_owner', 'approver', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, approver: 2, factory_owner: 3, org_admin: 4 };
export const roleAtLeast = (have: Role, need: Role): boolean => ROLE_RANK[have] >= ROLE_RANK[need];

export const INBOX_KINDS = ['question', 'context_request', 'spec_approval', 'pr_review', 'blocked', 'failed', 'connection', 'gate'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];


/** Which lane of the Floor an item sits in (spec 12.2): five phase lanes plus the human gate rail. */
export type Lane = Phase | 'GATE';
export function laneOf(state: WorkState, pausedState?: string | null): Lane | null {
  switch (state) {
    case 'INTAKE': return 'INTENT';
    case 'INTENT': case 'SPEC': case 'BUILD': case 'VERIFY': case 'SHIP': return state;
    case 'AWAITING_SPEC_APPROVAL': case 'AWAITING_GATE': return 'GATE';
    case 'AWAITING_HANDOFF': return 'SHIP';
    case 'NEEDS_INPUT': case 'BLOCKED': {
      const p = pausedState as WorkState | undefined;
      return p && p !== state ? laneOf(p) : 'INTENT';
    }
    default: return null; // COMPLETE, CANCELLED, FAILED leave the line
  }
}

export type TokenStatus = 'run' | 'ask' | 'gate' | 'loop' | 'blocked' | 'handoff' | 'queued';

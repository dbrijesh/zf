/** Normalised harness events (spec 8.1). Every adapter maps its native JSON stream into these. */
export type NormalisedEvent =
  | { kind: 'session.started'; sessionId: string; model?: string }
  | { kind: 'message.assistant'; text: string }
  | { kind: 'tool.call'; tool: string; input: unknown; id: string }
  | { kind: 'tool.result'; id: string; ok: boolean; summary: string }
  | { kind: 'file.changed'; path: string; op: 'add' | 'modify' | 'delete' }
  | { kind: 'command.run'; command: string; exitCode?: number }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number; premiumRequests?: number }
  | { kind: 'error'; message: string }
  | { kind: 'session.ended'; status: 'success' | 'error' | 'timeout' | 'cancelled' };

export type EventKind = NormalisedEvent['kind'];

/** Events emitted by the platform itself into the same run stream (not by harnesses). */
export type SystemEvent =
  | { kind: 'system.status'; text: string }
  | { kind: 'system.followup'; text: string; by?: string };

export type RunEvent = NormalisedEvent | SystemEvent;

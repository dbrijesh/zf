import type { tables as T } from '@zerovity/db';
import type { ResolvedAgent } from '@zerovity/harness-common';
import type { RunnerDef } from '@zerovity/definition';
import type { AssembleInput } from '@zerovity/context';
import type { RunResult, Usage, NormalisedEvent } from '@zerovity/core';

export type WorkItemRow = typeof T.workItems.$inferSelect;
export type RunRow = typeof T.runs.$inferSelect;
export type FactoryRow = typeof T.factories.$inferSelect;
export type RepoRow = typeof T.repositories.$inferSelect;
export type QuestionRow = typeof T.questions.$inferSelect;
export type GateRow = typeof T.gates.$inferSelect;
export type InboxRow = typeof T.inboxItems.$inferSelect;
export type MessageRow = typeof T.messages.$inferSelect;

/** Everything a worker needs to execute one run, already secret-resolved. Never persisted or logged. */
export interface RunPlan {
  run: { id: string; workItemId: string; factoryId: string; agentName: string; phase: string; harness: string; model?: string; attempt: number; reason: string };
  workItem: { id: string; shortId: string; title: string; body: string; branch: string; sourceUrl?: string | null; prUrl?: string | null; prNumber?: number | null };
  factory: { id: string; orgId: string; name: string; alias?: string | null };
  repo?: { id: string; forge: string; owner: string; name: string; defaultBranch: string; cloneUrl?: string | null; installId?: string | null };
  agent: ResolvedAgent;
  runner: RunnerDef & { name: string };
  instructions: string;
  prompt: string;
  contextInput: Omit<AssembleInput, 'extra'>;
  env: Record<string, string>;
  mcpServers: Record<string, { url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> }>;
  limits: { maxMinutes: number; idleMinutes: number; maxTokens: number };
  resumeSessionId?: string;
  skillFiles: Array<{ name: string; description: string; files: Record<string, string> }>;
  definitionVersionId: string;
  resultSchema: string;
  specFileName: string;
  concurrency: { factory: number; repo: number };
}

export interface RunOutcome {
  status: 'done' | 'failed' | 'timeout' | 'cancelled' | 'budget';
  result?: RunResult;
  sessionId?: string;
  exitReason?: string;
  usage?: Usage;
  headSha?: string;
  error?: string;
  repairAttempted?: boolean;
}

export type { RunResult, Usage, NormalisedEvent };

export interface SourceMessage { workItem: WorkItemRow; factoryId: string; kind: string; text: string }
export interface Notifier { send(m: SourceMessage): Promise<void> }

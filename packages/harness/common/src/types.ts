import type { HarnessType, NormalisedEvent, Usage, AgentPhase } from '@zerovity/core';

export type { HarnessType, NormalisedEvent, Usage };

export interface ResolvedSkillRef {
  name: string;
  description: string;
  files: Record<string, string>;
}

export interface ResolvedAgent {
  name: string;
  phase: AgentPhase;
  role?: string;
  /** agent.md body (the role text) */
  body: string;
  skills: ResolvedSkillRef[];
  outputs: string[];
  harness: { type: HarnessType; model?: string; reasoning?: 'low' | 'medium' | 'high' };
  /** names of MCP servers this agent may use */
  mcpServers: string[];
}

export interface RunSpec {
  runId: string;
  workItemId: string;
  agent: ResolvedAgent;
  /** phase prompt built by the orchestrator */
  prompt: string;
  /** path inside the sandbox (cwd of the harness process) */
  worktreePath: string;
  /** resolved secrets + gateway URLs; never logged */
  env: Record<string, string>;
  mcpConfigPath?: string;
  /** resolved MCP servers (url/headers or command), already secret-resolved; adapters write them into tool-specific config */
  mcpServers?: Record<string, { url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> }>;
  resumeSessionId?: string;
  limits: { maxMinutes: number; maxTokens: number };
  /** extra shell tool patterns the runner allows (e.g. "pnpm *") */
  extraAllowedShell?: string[];
}

export interface CommandSpec {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  /** files the worker must write before starting (path relative to the worktree, or absolute for config dirs) */
  files?: Record<string, string>;
  /** text to write to stdin, if any (otherwise stdin is closed) */
  stdin?: string;
}

export interface HarnessAdapter {
  type: HarnessType;
  detect(): Promise<{ installed: boolean; version?: string }>;
  buildCommand(spec: RunSpec): CommandSpec;
  /** one stdout line -> zero or more normalised events. Stateful per run (adapters are created per run). */
  parseLine(line: string, ctx?: { cwd?: string }): NormalisedEvent[];
  extractSessionId(events: NormalisedEvent[]): string | undefined;
  extractUsage(events: NormalisedEvent[]): Usage;
  sendFollowUp?(sessionId: string, message: string, spec: RunSpec): CommandSpec;
}

export const SESSION_EVENTS = ['session.started'] as const;

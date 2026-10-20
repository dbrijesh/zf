import type { HarnessType } from '@zerovity/core';
import type { HarnessAdapter } from '@zerovity/harness-common';
import { createClaudeCodeAdapter } from '@zerovity/harness-claude-code';
import { createCodexAdapter } from '@zerovity/harness-codex';
import { createCopilotAdapter } from '@zerovity/harness-copilot';
import { createCursorAdapter } from '@zerovity/harness-cursor';
import { createFakeAdapter } from '@zerovity/harness-fake';

export * from '@zerovity/harness-common';

/** Adapters hold per-run parser state, so always create a fresh one per run. */
export function createAdapter(type: HarnessType): HarnessAdapter {
  switch (type) {
    case 'claude-code': return createClaudeCodeAdapter();
    case 'codex': return createCodexAdapter();
    case 'copilot': return createCopilotAdapter();
    case 'cursor': return createCursorAdapter();
    case 'fake': return createFakeAdapter();
  }
}

export async function detectAll(): Promise<Record<HarnessType, { installed: boolean; version?: string }>> {
  const types: HarnessType[] = ['claude-code', 'codex', 'copilot', 'cursor', 'fake'];
  const r = await Promise.all(types.map(async (t) => [t, await createAdapter(t).detect()] as const));
  return Object.fromEntries(r) as Record<HarnessType, { installed: boolean; version?: string }>;
}

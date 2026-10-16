import { estimateTokens, ContextItemInputSchema, type ContextItemInput } from '@zerovity/core';
import { summarise, type ContextItemRecord } from './assemble';

/** Normalise any user input (note, glossary, adr, ticket...) into the stored body markdown + summary. */
export function buildItemBody(input: ContextItemInput): { body: string; summary: string; tokenCount: number; parsed: ReturnType<typeof ContextItemInputSchema.parse> } {
  const p = ContextItemInputSchema.parse(input);
  let body = p.body;
  const m = p.meta as Record<string, string | undefined>;
  if (p.kind === 'glossary') body = `**${m.term ?? p.title}**: ${m.definition ?? p.body}`;
  else if (p.kind === 'adr') body = `Status: ${m.status ?? 'Proposed'}\n\n${m.decision ?? p.body}`;
  else if (p.kind === 'repoPointer') body = `Repository path pointer: ${m.repo ?? 'this repository'} \`${m.glob ?? '**/*'}\` (read live from the worktree at run time).\n\n${p.body}`.trim();
  else if (p.kind === 'ticket') body = p.body;
  const summary = summarise(body) || p.title;
  return { body, summary, tokenCount: estimateTokens(body), parsed: p };
}

export function toRecord(row: { id: string; layer: string; scopeId: string; kind: string; title: string; body: string; summary: string; tags: string[]; appliesTo: { phases: string[]; agents: string[] }; priority: string; tokenCount: number; enabled: boolean; version: number; createdAt: Date; meta?: Record<string, unknown> }): ContextItemRecord {
  return { ...row, layer: row.layer as ContextItemRecord['layer'], priority: row.priority as ContextItemRecord['priority'] };
}

export const REPO_CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'];

/** The repo's own conventions files become a synthetic repo-layer item (they still apply to the harness natively too). */
export function repoConventionItems(files: Array<{ path: string; content: string }>, scopeId: string): ContextItemRecord[] {
  return files
    .filter((f) => f.content.trim())
    .map((f) => ({
      id: `repo-${f.path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`,
      layer: 'repo' as const, scopeId, kind: 'repoPointer', title: `${f.path} (repo conventions)`, body: f.content.trim().slice(0, 12_000), summary: summarise(f.content),
      tags: ['repo', 'conventions'], appliesTo: { phases: [], agents: [] }, priority: 'always' as const, tokenCount: estimateTokens(f.content.slice(0, 12_000)), enabled: true, version: 1, createdAt: new Date(0),
    }));
}

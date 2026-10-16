import { createHash } from 'node:crypto';
import { estimateTokens, canonicalJson, CONTEXT_LAYERS, type ContextLayer } from '@zerovity/core';

export interface ContextItemRecord {
  id: string;
  layer: ContextLayer;
  scopeId: string;
  kind: string;
  title: string;
  body: string;
  summary: string;
  tags: string[];
  appliesTo: { phases: string[]; agents: string[] };
  priority: 'always' | 'relevant' | 'on_request';
  tokenCount: number;
  enabled: boolean;
  version: number;
  createdAt: Date | string;
  meta?: Record<string, unknown>;
}

export interface QaEntry { question: string; kind: string; answer?: string; answeredBy?: string; answeredAt?: Date | string; phase?: string; asker?: string }

export interface AssembleInput {
  items: ContextItemRecord[];
  agent: { name: string; phase: string; contextScopes: string[]; tokenBudget?: number };
  workItem: { id: string; shortId: string; title: string; body: string; factoryId: string; repoKey?: string };
  qa: QaEntry[];
  /** per-work-item switches from the "what the agent sees" panel: itemId -> enabled */
  toggles?: Record<string, boolean>;
  /** extra synthetic items, e.g. the repo's own AGENTS.md / CLAUDE.md, repoPointer resolutions */
  extra?: ContextItemRecord[];
}

export type ItemForm = 'full' | 'index' | 'dropped';
export interface ReportLine {
  id: string; title: string; layer: ContextLayer; kind: string; priority: string; tokens: number;
  form: ItemForm; reason?: 'filtered' | 'disabled' | 'over_budget' | 'not_in_scope' | 'on_request' | 'relevant_in_index';
}

export interface ContextBundle {
  contextMd: string;
  items: Record<string, string>; // id -> markdown (items/<id>.md)
  report: ReportLine[];
  tokens: number;
  budget: number;
  trimmed: boolean;
  bundleHash: string;
}

export const DEFAULT_CONTEXT_BUDGET = 12_000;
const LAYER_RANK = Object.fromEntries(CONTEXT_LAYERS.map((l, i) => [l, i])) as Record<ContextLayer, number>;
const when = (d: Date | string) => new Date(d).getTime();

/** Does this item apply for this agent, phase and work item? (scope + filters, before toggles and budget) */
export function itemApplies(it: ContextItemRecord, inp: Pick<AssembleInput, 'agent' | 'workItem'>): ReportLine['reason'] | 'ok' {
  if (!inp.agent.contextScopes.includes(it.layer)) return 'not_in_scope';
  const { workItem } = inp;
  if (it.layer === 'factory' && it.scopeId && it.scopeId !== workItem.factoryId) return 'not_in_scope';
  if (it.layer === 'repo' && it.scopeId && it.scopeId !== workItem.repoKey) return 'not_in_scope';
  if (it.layer === 'workItem' && it.scopeId !== workItem.id) return 'not_in_scope';
  if (it.layer === 'phase' && it.scopeId !== `${workItem.id}:${inp.agent.phase}`) return 'not_in_scope';
  if (it.appliesTo.phases.length && !it.appliesTo.phases.includes(inp.agent.phase)) return 'filtered';
  if (it.appliesTo.agents.length && !it.appliesTo.agents.includes(inp.agent.name)) return 'filtered';
  return 'ok';
}

export function summarise(body: string, max = 140): string {
  const t = body.replace(/^---[\s\S]*?---\s*/, '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find((l) => l.length > 0) ?? '';
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const itemMd = (it: ContextItemRecord) => `## [${it.layer}] ${it.title}\n_id: ${it.id} · ${it.kind} · v${it.version}_\n\n${it.body.trim()}\n`;
const indexLine = (it: ContextItemRecord) => `- \`${it.id}\` **${it.title}** (${it.layer}, ~${fmtK(it.tokenCount)} tokens): ${it.summary || summarise(it.body)} → \`.zerovity/context/items/${it.id}.md\``;

export function qaMarkdown(qa: QaEntry[]): string {
  if (!qa.length) return '';
  const lines = ['## Question and answer history', ''];
  for (const q of qa) {
    lines.push(`### Q: ${q.question}`);
    if (q.answer !== undefined) lines.push(`Answer: ${q.answer}`, `_answered${q.answeredBy ? ` by ${q.answeredBy}` : ''}${q.answeredAt ? ` on ${new Date(q.answeredAt).toISOString().slice(0, 10)}` : ''}_`);
    else lines.push('_Not answered yet._');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Build the context bundle for one run (spec 9.3).
 *  - CONTEXT.md = header + index + `always` items (org -> factory -> repo -> workItem -> phase) + Q&A history
 *  - items/<id>.md = every `relevant` / `on_request` item, listed in the index with a one-line summary
 *  - `relevant` items are inlined while the budget allows; over budget they fall back to index-only,
 *    lowest layer and oldest first; Q&A answers are never dropped.
 */
export function assembleContext(inp: AssembleInput): ContextBundle {
  const budget = inp.agent.tokenBudget ?? DEFAULT_CONTEXT_BUDGET;
  const report: ReportLine[] = [];
  const candidates: ContextItemRecord[] = [];
  for (const it of [...inp.items, ...(inp.extra ?? [])]) {
    const base = { id: it.id, title: it.title, layer: it.layer, kind: it.kind, priority: it.priority, tokens: it.tokenCount || estimateTokens(it.body) };
    const ap = itemApplies(it, inp);
    if (ap !== 'ok') { report.push({ ...base, form: 'dropped', reason: ap }); continue; }
    const toggled = inp.toggles?.[it.id];
    if ((toggled === false) || (toggled === undefined && !it.enabled)) { report.push({ ...base, form: 'dropped', reason: 'disabled' }); continue; }
    candidates.push({ ...it, tokenCount: base.tokens });
  }
  const order = (a: ContextItemRecord, b: ContextItemRecord) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer] || when(a.createdAt) - when(b.createdAt) || a.id.localeCompare(b.id);
  candidates.sort(order);

  const qaMd = qaMarkdown(inp.qa);
  const header = [`# Context for ${inp.workItem.shortId}: ${inp.workItem.title}`, `Agent: ${inp.agent.name} · phase ${inp.agent.phase}. Layers are ordered org, factory, repo, work item, phase; later layers refine earlier ones.`, ''].join('\n');
  const form = new Map<string, ItemForm>();
  for (const it of candidates) form.set(it.id, it.priority === 'always' ? 'full' : it.priority === 'relevant' ? 'full' : 'index');

  const render = () => {
    const full = candidates.filter((c) => form.get(c.id) === 'full');
    const indexed = candidates.filter((c) => form.get(c.id) === 'index');
    const indexSection = indexed.length ? ['## Index of items you can open when needed', '', ...indexed.map(indexLine), ''].join('\n') : '';
    const body = full.map(itemMd).join('\n');
    return { md: [header, indexSection, body ? '## Items\n\n' + body : '', qaMd].filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n'), full, indexed };
  };

  let cur = render();
  let trimmed = false;
  const demote = (pred: (c: ContextItemRecord) => boolean) => {
    const list = candidates.filter((c) => form.get(c.id) === 'full' && pred(c)).sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer] || when(a.createdAt) - when(b.createdAt));
    for (const c of list) {
      if (estimateTokens(cur.md) <= budget) return;
      form.set(c.id, 'index');
      trimmed = true;
      cur = render();
    }
  };
  // relevant first, then always-items from the broad layers; work item / phase items last
  demote((c) => c.priority === 'relevant');
  demote((c) => c.priority === 'always' && (c.layer === 'org' || c.layer === 'factory' || c.layer === 'repo'));
  demote((c) => c.priority === 'always');

  const items: Record<string, string> = {};
  for (const c of candidates) if (form.get(c.id) === 'index') items[c.id] = itemMd(c);
  for (const c of candidates) {
    const f = form.get(c.id)!;
    report.push({ id: c.id, title: c.title, layer: c.layer, kind: c.kind, priority: c.priority, tokens: c.tokenCount, form: f, reason: f === 'index' ? (c.priority === 'on_request' ? 'on_request' : c.priority === 'relevant' ? 'relevant_in_index' : 'over_budget') : undefined });
  }
  const tokens = estimateTokens(cur.md);
  const bundleHash = createHash('sha256').update(canonicalJson({ md: cur.md, items })).digest('hex');
  return { contextMd: cur.md, items, report, tokens, budget, trimmed, bundleHash };
}

/** Files to write into the worktree. */
export function bundleToFiles(b: ContextBundle): Record<string, string> {
  const files: Record<string, string> = { '.zerovity/context/CONTEXT.md': b.contextMd };
  for (const [id, md] of Object.entries(b.items)) files[`.zerovity/context/items/${id}.md`] = md;
  return files;
}

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { errMessage } from '@zerovity/core';

export interface JudgeInput {
  scorer: { name: string; rubric: string; labels: string[]; passLabels: string[] };
  subject: { agent: string; phase: string; harness: string; status: string; summary: string; recommendation?: string; findings: Array<{ severity: string; text: string }>; artifacts: Array<{ name: string; text: string }> };
}
export interface JudgeResult { label: string; score: number; rationale: string; judge: string }
export interface Judge { readonly name: string; judge(i: JudgeInput): Promise<JudgeResult> }

/** Deterministic sampling: the same run always makes the same decision, so re-scoring is stable. */
export function shouldSample(runId: string, scorerName: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const h = createHash('sha256').update(`${runId}:${scorerName}`).digest();
  return h.readUInt32BE(0) / 0xffffffff < rate;
}

/** Position-based score: first label is best (1), last is worst (0), pass labels always score at least 0.8. */
export function scoreForLabel(label: string, labels: string[], passLabels: string[]): number {
  if (passLabels.includes(label)) return Math.max(0.8, 1 - labels.indexOf(label) * 0.1);
  const i = labels.indexOf(label);
  return labels.length > 1 && i >= 0 ? Math.max(0, 1 - i / (labels.length - 1)) * 0.6 : 0;
}

/** Offline judge: structural checks only. Useful for demos and as a floor when no model is configured. */
export class HeuristicJudge implements Judge {
  readonly name = 'heuristic';
  async judge(i: JudgeInput): Promise<JudgeResult> {
    const { labels, passLabels } = i.scorer;
    const best = passLabels[0] ?? labels[0];
    const worst = labels[labels.length - 1];
    const mid = labels.length > 2 ? labels[Math.floor((labels.length - 1) / 2)] : worst;
    const spec = i.subject.artifacts.find((a) => /spec/i.test(a.name))?.text ?? '';
    const reasons: string[] = [];
    let label = best;
    if (i.subject.status !== 'done') { label = worst; reasons.push(`run ended ${i.subject.status}`); }
    const high = i.subject.findings.filter((f) => f.severity === 'high' || f.severity === 'critical');
    if (high.length) { label = worst; reasons.push(`${high.length} high-severity finding(s)`); }
    if (/spec/i.test(i.scorer.name + i.scorer.rubric) && i.subject.phase === 'SPEC') {
      const reqs = new Set(spec.match(/\bR\d+\b/g) ?? []);
      const acs = new Set(spec.match(/\bAC\d+\b/g) ?? []);
      if (!reqs.size) { label = worst; reasons.push('no numbered requirements'); }
      else if (acs.size < reqs.size) { if (label === best) label = mid; reasons.push(`${reqs.size} requirements but ${acs.size} acceptance criteria`); }
      else reasons.push(`${reqs.size} requirements, ${acs.size} acceptance criteria`);
    }
    if (!i.subject.summary.trim() && label === best) { label = mid; reasons.push('no summary written'); }
    if (!reasons.length) reasons.push('run finished with a summary and no high findings');
    return { label, score: scoreForLabel(label, labels, passLabels), rationale: reasons.join('; '), judge: this.name };
  }
}

const ReplySchema = z.object({ label: z.string(), rationale: z.string() });

/** LLM-as-judge via the Anthropic Messages API (spec 1.1 scorers); falls back to the heuristic judge on any error. */
export class LlmJudge implements Judge {
  readonly name = 'llm';
  private fb = new HeuristicJudge();
  constructor(private o: { apiKey: string; model?: string; baseUrl?: string; fetchImpl?: typeof fetch }) {}
  async judge(i: JudgeInput): Promise<JudgeResult> {
    try {
      const f = this.o.fetchImpl ?? fetch;
      const r = await f(`${(this.o.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': this.o.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.o.model ?? 'claude-haiku-5-5', max_tokens: 400, system: `You are a strict reviewer scoring one agent run against a rubric. Allowed labels: ${i.scorer.labels.join(', ')}. Reply with JSON only: {"label": "...", "rationale": "two sentences"}.`, messages: [{ role: 'user', content: `Rubric:\n${i.scorer.rubric}\n\nRun (${i.subject.agent}, ${i.subject.phase}, ${i.subject.status}):\n${i.subject.summary}\n\nFindings: ${JSON.stringify(i.subject.findings)}\n\n${i.subject.artifacts.map((a) => `--- ${a.name}\n${a.text.slice(0, 6000)}`).join('\n')}` }] }),
      });
      if (!r.ok) throw new Error(`judge http ${r.status}`);
      const j = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = (j.content ?? []).map((c) => c.text ?? '').join('');
      const parsed = ReplySchema.parse(JSON.parse(/\{[\s\S]*\}/.exec(text)![0]));
      if (!i.scorer.labels.includes(parsed.label)) throw new Error(`label ${parsed.label} not allowed`);
      return { label: parsed.label, score: scoreForLabel(parsed.label, i.scorer.labels, i.scorer.passLabels), rationale: parsed.rationale, judge: `llm:${this.o.model ?? 'claude-haiku-5-5'}` };
    } catch (e) {
      const res = await this.fb.judge(i);
      return { ...res, rationale: `${res.rationale} (llm judge unavailable: ${errMessage(e)})` };
    }
  }
}

export function judgeFromEnv(env: NodeJS.ProcessEnv = process.env): Judge {
  const key = env.ZF_JUDGE_API_KEY ?? env.ANTHROPIC_API_KEY ?? env.ZF_SECRET_ANTHROPIC_API_KEY;
  if (env.ZF_JUDGE === 'heuristic' || !key) return new HeuristicJudge();
  return new LlmJudge({ apiKey: key, model: env.ZF_JUDGE_MODEL, baseUrl: env.ZF_JUDGE_BASE_URL });
}

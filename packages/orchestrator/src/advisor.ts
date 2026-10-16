import { z } from 'zod';
import { IntakeDecisionSchema, QuestionRewriteSchema, HandoffSummarySchema, type IntakeDecision, type QuestionRewrite, type HandoffSummary, type Question, errMessage } from '@zerovity/core';

/**
 * The foreman's LLM advisor (spec 10.2). It is called only at decision points and always returns
 * structured JSON validated with Zod. Failure of any kind falls back to the deterministic rules,
 * so the factory never depends on the advisor being up. Every decision is audit-logged by the caller.
 */
export interface Advisor {
  readonly name: string;
  decideIntake(i: { title: string; body: string; factory: string; phasesAvailable: string[] }): Promise<AdvisorResult<IntakeDecision>>;
  rewriteQuestions(i: { title: string; agent: string; questions: Question[]; summary?: string }): Promise<AdvisorResult<QuestionRewrite>>;
  summariseHandoff(i: { title: string; recommendation?: string; findings: Array<{ severity: string; text: string; file?: string }>; summary?: string; flags: string[]; prUrl?: string | null }): Promise<AdvisorResult<HandoffSummary>>;
}

export interface AdvisorResult<T> { value: T; source: 'llm' | 'rules'; fallbackReason?: string; model?: string }

const SPEC_MARK = /\b(acceptance criteria|given .{3,80} when .{3,80} then|AC\d+|R\d+\b|## ?requirements)\b/i;
const BUILD_MARK = /\b(approved spec|spec approved|implement(?:ation)? plan|docs\/specs\/)\b/i;

/** Deterministic default: no model, no network. Also the fallback for the LLM advisor. */
export class RuleAdvisor implements Advisor {
  readonly name = 'rules';

  async decideIntake(i: { title: string; body: string; phasesAvailable: string[] }): Promise<AdvisorResult<IntakeDecision>> {
    const text = `${i.title}\n${i.body}`;
    let startPhase: IntakeDecision['startPhase'] = 'INTENT';
    let why = 'Default: start with intent so gaps are found before any spec is written.';
    const forced = /\[start:(intent|spec|build)\]/i.exec(text)?.[1]?.toUpperCase() as IntakeDecision['startPhase'] | undefined;
    if (forced && i.phasesAvailable.includes(forced)) { startPhase = forced; why = `Requester asked to start at ${forced}.`; }
    else if (BUILD_MARK.test(text) && i.phasesAvailable.includes('BUILD')) { startPhase = 'BUILD'; why = 'The request references an approved spec or plan.'; }
    else if (SPEC_MARK.test(text) && text.length > 280 && i.phasesAvailable.includes('SPEC')) { startPhase = 'SPEC'; why = 'The request already contains requirements and acceptance criteria.'; }
    return { value: { startPhase, rationale: why }, source: 'rules' };
  }

  async rewriteQuestions(i: { questions: Question[]; agent: string }): Promise<AdvisorResult<QuestionRewrite>> {
    const qs = i.questions;
    const message = qs.length === 1 ? `${i.agent} needs one thing before it can continue:\n\n${qs[0].text}${qs[0].why ? `\n\n(${qs[0].why})` : ''}` : `${i.agent} needs ${qs.length} things before it can continue:\n\n${qs.map((q, n) => `${n + 1}. ${q.text}${q.options?.length ? ` (${q.options.join(' / ')})` : ''}`).join('\n')}`;
    return { value: { message }, source: 'rules' };
  }

  async summariseHandoff(i: { title: string; recommendation?: string; findings: Array<{ severity: string; text: string }>; summary?: string; flags: string[]; prUrl?: string | null }): Promise<AdvisorResult<HandoffSummary>> {
    const high = i.findings.filter((f) => f.severity === 'high' || f.severity === 'critical');
    const lines = [`"${i.title}" is ready for your review${i.prUrl ? `: ${i.prUrl}` : '.'}`, `Verification recommendation: ${i.recommendation ?? 'none recorded'}.`];
    if (i.summary) lines.push(i.summary);
    if (i.findings.length) lines.push(`${i.findings.length} finding(s) were reported${high.length ? `, ${high.length} high or critical` : ''}.`);
    if (i.flags.length) lines.push(`Flags: ${i.flags.join('; ')}.`);
    lines.push('Agents never merge; please review and merge when satisfied.');
    return { value: { message: lines.join('\n'), risks: i.flags }, source: 'rules' };
  }
}

export interface LlmAdvisorOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Anthropic Messages API advisor with JSON output; wraps a RuleAdvisor for fallback. */
export class LlmAdvisor implements Advisor {
  readonly name = 'llm';
  private rules = new RuleAdvisor();
  constructor(private o: LlmAdvisorOptions) {}
  private get model() { return this.o.model ?? 'claude-haiku-5-5'; }

  private async ask<T>(schema: z.ZodType<T>, system: string, user: string): Promise<T> {
    const f = this.o.fetchImpl ?? fetch;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 20_000);
    try {
      const r = await f(`${(this.o.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': this.o.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.model, max_tokens: 700, system: `${system}\nReply with one JSON object only, no prose, no code fence.`, messages: [{ role: 'user', content: user }] }),
      });
      if (!r.ok) throw new Error(`advisor http ${r.status}`);
      const j = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      const json = /\{[\s\S]*\}/.exec(text)?.[0];
      if (!json) throw new Error('advisor returned no JSON');
      return schema.parse(JSON.parse(json));
    } finally {
      clearTimeout(t);
    }
  }

  private async withFallback<T>(fn: () => Promise<T>, fb: () => Promise<AdvisorResult<T>>): Promise<AdvisorResult<T>> {
    try {
      return { value: await fn(), source: 'llm', model: this.model };
    } catch (e) {
      const r = await fb();
      return { ...r, fallbackReason: errMessage(e) };
    }
  }

  decideIntake(i: Parameters<Advisor['decideIntake']>[0]) {
    return this.withFallback(async () => {
      const v = await this.ask(IntakeDecisionSchema, 'You are the foreman of a software factory. Decide which phase a new request should start in: INTENT (needs investigation or has gaps), SPEC (clear request, needs a written spec), BUILD (an approved spec already exists). Prefer INTENT when unsure. Fields: startPhase, askFirst (optional string), rationale.', `Factory: ${i.factory}\nAvailable phases: ${i.phasesAvailable.join(', ')}\nTitle: ${i.title}\n\n${i.body.slice(0, 6000)}`);
      return i.phasesAvailable.includes(v.startPhase) ? v : { ...v, startPhase: 'INTENT' as const };
    }, () => this.rules.decideIntake(i));
  }
  rewriteQuestions(i: Parameters<Advisor['rewriteQuestions']>[0]) {
    return this.withFallback(() => this.ask(QuestionRewriteSchema, 'You are the foreman. Merge the agent questions into ONE short, clear message to the requester. Keep concrete examples and options. Fields: message, rationale.', JSON.stringify({ title: i.title, agent: i.agent, questions: i.questions })), () => this.rules.rewriteQuestions(i));
  }
  summariseHandoff(i: Parameters<Advisor['summariseHandoff']>[0]) {
    return this.withFallback(() => this.ask(HandoffSummarySchema, 'You are the foreman. Write the handoff note for the person who will review the pull request: outcome, what to look at first, honest risks. No hype. Fields: message, risks (array of strings).', JSON.stringify(i)), () => this.rules.summariseHandoff(i));
  }
}

export function advisorFromEnv(env: NodeJS.ProcessEnv = process.env): Advisor {
  const key = env.ZF_ADVISOR_API_KEY ?? env.ANTHROPIC_API_KEY ?? env.ZF_SECRET_ANTHROPIC_API_KEY;
  if (env.ZF_ADVISOR === 'rules' || !key) return new RuleAdvisor();
  return new LlmAdvisor({ apiKey: key, model: env.ZF_ADVISOR_MODEL, baseUrl: env.ZF_ADVISOR_BASE_URL ?? env.ANTHROPIC_BASE_URL });
}

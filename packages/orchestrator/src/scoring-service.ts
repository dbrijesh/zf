import { and, desc, eq, inArray } from 'drizzle-orm';
import { ulid, errMessage, type RunResult } from '@zerovity/core';
import { tables as t, appendAudit, type Db, type ArtifactStore } from '@zerovity/db';
import { shouldSample, type Judge } from '@zerovity/scoring';
import type { Definition } from '@zerovity/definition';

/** Mirror scorers declared in the definition into the scorers table (UI-edited ones keep their rows). */
export async function syncScorers(db: Db, factoryId: string, def: Definition): Promise<void> {
  const rows = await db.select().from(t.scorers).where(eq(t.scorers.factoryId, factoryId));
  for (const s of Object.values(def.scorers)) {
    const ex = rows.find((r) => r.name === s.name);
    const v = { description: s.fm.description, rubric: s.body.trim(), labels: s.fm.labels, passLabels: s.fm.passLabels, sampling: s.fm.sampling, appliesTo: s.fm.appliesTo, harness: s.fm.harness ?? null, updatedAt: new Date() };
    if (ex) await db.update(t.scorers).set(v).where(eq(t.scorers.id, ex.id));
    else await db.insert(t.scorers).values({ id: ulid(), factoryId, name: s.name, ...v });
  }
}

export class ScoringService {
  constructor(private db: Db, private artifacts: ArtifactStore, private judge: Judge) {}

  /** Score a finished run against every applicable, sampled scorer. Errors never affect the work item. */
  async scoreRun(runId: string, opts: { force?: boolean; scorerId?: string } = {}): Promise<number> {
    const [run] = await this.db.select().from(t.runs).where(eq(t.runs.id, runId));
    if (!run || !['done', 'failed', 'needs_input', 'blocked'].includes(run.status)) return 0;
    const scorers = await this.db.select().from(t.scorers).where(and(eq(t.scorers.factoryId, run.factoryId), eq(t.scorers.enabled, true)));
    const result = run.resultJson as RunResult | null;
    let n = 0;
    for (const s of scorers) {
      if (opts.scorerId && s.id !== opts.scorerId) continue;
      if (s.appliesTo.phases.length && !s.appliesTo.phases.includes(run.phase)) continue;
      if (s.appliesTo.agents.length && !s.appliesTo.agents.includes(run.agentName)) continue;
      if (!opts.force && !shouldSample(run.id, s.name, s.sampling)) continue;
      try {
        const arts: Array<{ name: string; text: string }> = [];
        for (const a of result?.artifacts ?? []) {
          const name = a.path.replace(/^\.zerovity\/out\//, '');
          const buf = await this.artifacts.get(`runs/${run.id}/out/${name}`);
          if (buf) arts.push({ name, text: buf.toString('utf8') });
        }
        const r = await this.judge.judge({ scorer: { name: s.name, rubric: s.rubric, labels: s.labels, passLabels: s.passLabels }, subject: { agent: run.agentName, phase: run.phase, harness: run.harness, status: run.status, summary: result?.summary ?? '', recommendation: result?.recommendation, findings: result?.findings ?? [], artifacts: arts } });
        await this.db.insert(t.scores).values({ id: ulid(), runId: run.id, scorerId: s.id, label: r.label, score: r.score, rationale: r.rationale, judge: r.judge }).onConflictDoUpdate({ target: [t.scores.runId, t.scores.scorerId], set: { label: r.label, score: r.score, rationale: r.rationale, judge: r.judge } });
        await appendAudit(this.db, { chain: run.factoryId, factoryId: run.factoryId, actor: `scorer:${s.name}`, action: 'score.recorded', subject: run.id, payload: { label: r.label, score: r.score, judge: r.judge } });
        n++;
      } catch (e) {
        await appendAudit(this.db, { chain: run.factoryId, factoryId: run.factoryId, actor: `scorer:${s.name}`, action: 'score.failed', subject: run.id, payload: { error: errMessage(e) } }).catch(() => undefined);
      }
    }
    return n;
  }

  async recent(factoryId: string, limit = 50) {
    const rows = await this.db.select({ score: t.scores, scorer: t.scorers, run: t.runs }).from(t.scores).innerJoin(t.scorers, eq(t.scores.scorerId, t.scorers.id)).innerJoin(t.runs, eq(t.scores.runId, t.runs.id)).where(eq(t.scorers.factoryId, factoryId)).orderBy(desc(t.scores.createdAt)).limit(limit);
    return rows.map((r) => ({ id: r.score.id, runId: r.run.id, workItemId: r.run.workItemId, scorer: r.scorer.name, scorerId: r.scorer.id, agent: r.run.agentName, phase: r.run.phase, harness: r.run.harness, label: r.score.label, score: r.score.score, pass: r.scorer.passLabels.includes(r.score.label), rationale: r.score.rationale, judge: r.score.judge, createdAt: r.score.createdAt }));
  }

  async passRates(factoryId: string): Promise<Array<{ scorer: string; scorerId: string; total: number; pass: number; rate: number; labels: Record<string, number> }>> {
    const scorers = await this.db.select().from(t.scorers).where(eq(t.scorers.factoryId, factoryId));
    if (!scorers.length) return [];
    const scores = await this.db.select().from(t.scores).where(inArray(t.scores.scorerId, scorers.map((s) => s.id)));
    return scorers.map((s) => {
      const mine = scores.filter((x) => x.scorerId === s.id);
      const labels: Record<string, number> = {};
      for (const m of mine) labels[m.label] = (labels[m.label] ?? 0) + 1;
      const pass = mine.filter((m) => s.passLabels.includes(m.label)).length;
      return { scorer: s.name, scorerId: s.id, total: mine.length, pass, rate: mine.length ? pass / mine.length : 0, labels };
    });
  }
}

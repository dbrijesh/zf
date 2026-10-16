import os from 'node:os';
import { errMessage, redactText, nullLogger, ulid, type Logger } from '@zerovity/core';
import type { Services } from '@zerovity/orchestrator';
import { RUN_QUEUE } from '@zerovity/orchestrator';
import type { Job } from '@zerovity/db';
import type { ForgeResolver } from '@zerovity/forge-common';
import { executeRun, type ExecutorDeps } from './executor';

export interface WorkerOptions {
  id?: string;
  concurrency?: number;
  pollMs?: number;
  sandbox?: 'local' | 'docker';
  forges?: ForgeResolver;
  log?: Logger;
  /** run orch.tick() (question reminders, lock reaping) about every minute */
  maintenance?: boolean;
  docker?: ExecutorDeps['docker'];
  localSetup?: boolean;
}

/** Pulls run jobs from the Postgres queue and executes them (spec 3: apps/worker). */
export class Worker {
  readonly id: string;
  private active = new Map<string, Promise<void>>();
  private stopped = true;
  private loop?: Promise<void>;
  private maint?: ReturnType<typeof setInterval>;
  private log: Logger;
  private wake?: () => void;

  constructor(private s: Services, private o: WorkerOptions = {}) {
    this.id = o.id ?? `${os.hostname()}-${process.pid}-${ulid().slice(-6)}`;
    this.log = (o.log ?? s.log ?? nullLogger).child({ worker: this.id });
  }

  get running(): number { return this.active.size; }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    const n = await this.s.orch.reconcile(0);
    if (n) this.log.warn('failed runs left behind by a previous worker', { runs: n });
    this.loop = this.run();
    this.s.hub.subscribe((e) => { if (e.type === 'changed') this.wake?.(); });
    if (this.o.maintenance !== false) this.maint = setInterval(() => void this.s.orch.tick().catch((e) => this.log.warn('tick failed', { error: errMessage(e) })), 60_000);
  }

  async stop(graceMs = 0): Promise<void> {
    this.stopped = true;
    if (this.maint) clearInterval(this.maint);
    this.wake?.();
    await this.loop;
    if (graceMs) await Promise.race([Promise.all(this.active.values()), new Promise((r) => setTimeout(r, graceMs))]);
  }

  /** Resolves once the queue is idle and nothing is running (tests and `zf run`). */
  async drain(timeoutMs = 120_000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      const st = await this.s.queue.stats(RUN_QUEUE);
      if (!this.active.size && !(st.created ?? 0) && !(st.active ?? 0)) return;
      if (Date.now() - t0 > timeoutMs) throw new Error('worker drain timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async run(): Promise<void> {
    const conc = this.o.concurrency ?? 2;
    while (!this.stopped) {
      let claimed = false;
      if (this.active.size < conc) {
        const job = await this.s.queue.claim(RUN_QUEUE, this.id, 120_000).catch((e) => { this.log.error('claim failed', { error: errMessage(e) }); return undefined; });
        if (job) {
          claimed = true;
          const p = this.handle(job).finally(() => this.active.delete(job.id));
          this.active.set(job.id, p);
        }
      }
      if (!claimed) await new Promise<void>((r) => { const t = setTimeout(r, this.o.pollMs ?? 500); this.wake = () => { clearTimeout(t); r(); }; });
    }
  }

  private async handle(job: Job): Promise<void> {
    const { runId, reason, resume, message } = job.payload as { runId: string; reason?: string; resume?: boolean; message?: string };
    const log = this.log.child({ runId });
    const hb = setInterval(() => void this.s.queue.heartbeat(job.id, 120_000).catch(() => undefined), 30_000);
    try {
      const can = await this.s.orch.canStart(runId);
      if (!can.ok) {
        if (can.reason === 'run not found' || /^run is /.test(can.reason ?? '')) { await this.s.queue.complete(job.id); return; }
        await this.s.queue.release(job.id, 3000);
        return;
      }
      const plan = await this.s.orch.prepareRun(runId, { reason, resume, message });
      log.info('run starting', { agent: plan.run.agentName, harness: plan.run.harness, phase: plan.run.phase, workItemId: plan.workItem.id, factoryId: plan.factory.id });
      const outcome = await executeRun(plan, { orch: this.s.orch, artifacts: this.s.artifacts, forges: this.o.forges, dataDir: this.s.dataDir, sandbox: this.o.sandbox ?? 'local', log, docker: this.o.docker, localSetup: this.o.localSetup });
      await this.s.orch.finishRun(runId, outcome);
      log.info('run finished', { status: outcome.status, exitReason: outcome.exitReason });
      await this.s.queue.complete(job.id);
    } catch (e) {
      const msg = redactText(errMessage(e));
      log.error('run job failed', { error: msg });
      try { await this.s.orch.finishRun(runId, { status: 'failed', exitReason: 'worker_error', error: msg }); } catch (e2) { log.error('could not record failure', { error: errMessage(e2) }); }
      await this.s.queue.fail(job, msg, 0).catch(() => undefined);
    } finally {
      clearInterval(hb);
    }
  }
}

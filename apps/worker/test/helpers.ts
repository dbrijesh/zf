import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createServices, ensureOrg, ensureUser, createFactory, loadExample, findRepoRoot, RuleAdvisor, type Services } from '@zerovity/orchestrator';
import { tables as t } from '@zerovity/db';
import { Worker } from '../src/worker';

export const ROOT = findRepoRoot(import.meta.dirname);

export interface Harness { s: Services; w: Worker; orgId: string; factoryId: string; approver: { id: string; name: string }; tmp: string; stop(): Promise<void>; waitState(id: string, state: string | string[], ms?: number): Promise<typeof t.workItems.$inferSelect> }

export async function setup(opts: { example?: string; patch?: (files: Record<string, string>) => Record<string, string>; concurrency?: number } = {}): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-e2e-'));
  const s = await createServices({ memory: true, dataDir: tmp, forceHarness: 'fake', advisor: new RuleAdvisor(), log: { info() {}, warn() {}, error() {}, child() { return this; } } as never, repoRoot: ROOT, masterKey: Buffer.alloc(32, 3) });
  const org = await ensureOrg(s.db);
  const approver = await ensureUser(s.db, org.id, { email: 'priya@acme.test', name: 'Priya N.', role: 'approver', groups: ['tech-leads'] });
  let files = loadExample(ROOT, opts.example ?? '02-issue-to-pr');
  if (opts.patch) files = opts.patch(files);
  await s.secrets.set('org', org.id, 'JIRA_MCP_TOKEN', 'jira-test-token-0001');
  const { factoryId, apply } = await createFactory(s, { orgId: org.id, files, by: approver.id });
  if (!apply.ok) throw new Error('definition invalid: ' + JSON.stringify(apply.issues.filter((i) => i.severity === 'error')));
  const w = new Worker(s, { concurrency: opts.concurrency ?? 2, pollMs: 40, sandbox: 'local', maintenance: false });
  await w.start();
  return {
    s, w, orgId: org.id, factoryId, approver: { id: approver.id, name: approver.name }, tmp,
    async stop() { await w.stop(5000); await s.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
    async waitState(id, state, ms = 40_000) {
      const want = Array.isArray(state) ? state : [state];
      const t0 = Date.now();
      for (;;) {
        const [row] = await s.db.select().from(t.workItems).where(eq(t.workItems.id, id));
        if (want.includes(row.state)) return row;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${want.join('|')}; item is ${row.state} (paused ${row.pausedState}); runs: ${JSON.stringify((await s.db.select().from(t.runs).where(eq(t.runs.workItemId, id))).map((r) => `${r.phase}:${r.status}:${r.exitReason ?? ''}`))}`);
        await new Promise((r) => setTimeout(r, 40));
      }
    },
  };
}

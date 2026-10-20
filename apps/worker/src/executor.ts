import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { ResultSchema, errMessage, redactText, type NormalisedEvent, type Logger, nullLogger, type RunResult } from '@zerovity/core';
import { tables as t, type ArtifactStore } from '@zerovity/db';
import { createAdapter, REPAIR_PROMPT, RESULT_PATH, INSTRUCTIONS_PATH, RESULT_SCHEMA_PATH, OUT_DIR, type RunSpec, type CommandSpec } from '@zerovity/harness';
import { assembleContext, bundleToFiles, repoConventionItems, REPO_CONVENTION_FILES } from '@zerovity/context';
import { materialiseSkills, MATERIALISE_TABLE } from '@zerovity/skills';
import type { Orchestrator, RunPlan, RunOutcome } from '@zerovity/orchestrator';
import type { ForgeResolver } from '@zerovity/forge-common';
import { prepareWorkspace, commitAll, pushBranch, diffAgainst, changedFiles, humanCommits, agentGitEnv } from './git';
import { Overlay, recoverOverlay } from './overlay';
import { LocalSandbox, DockerSandbox, startEgressProxy, type Sandbox } from './sandbox';

export interface ExecutorDeps {
  orch: Orchestrator; artifacts: ArtifactStore; forges?: ForgeResolver; dataDir: string; sandbox: 'local' | 'docker'; log?: Logger;
  docker?: { network?: string; proxyHost?: string; user?: string };
  /** run `runner.setupCommands` on the host in local mode (off by default: they are meant for containers) */
  localSetup?: boolean;
  followupPollMs?: number;
}

const FLUSH_MS = 250;

/** Give a folder tree to a uid:gid (only meaningful when the worker runs as root, for the non-root container user). */
function chownTree(dir: string, uid: number, gid: number) {
  try { fs.chownSync(dir, uid, gid); } catch { return; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try { if (e.isSymbolicLink()) fs.lchownSync(p, uid, gid); else if (e.isDirectory()) chownTree(p, uid, gid); else fs.chownSync(p, uid, gid); } catch { /* skip */ }
  }
}
const MAX_ARTIFACT = 5 * 1024 * 1024;

/** Execute one planned run end to end and return its outcome. Never throws for run-level problems. */
export async function executeRun(plan: RunPlan, deps: ExecutorDeps): Promise<RunOutcome> {
  const log = (deps.log ?? nullLogger).child({ factoryId: plan.factory.id, workItemId: plan.workItem.id, runId: plan.run.id });
  const { orch } = deps;
  const runId = plan.run.id;
  const wsRoot = path.join(deps.dataDir, 'workspaces', plan.workItem.shortId);
  // when the worker itself runs in a container, bind mounts must name the path on the Docker host
  const toHost = (p: string) => (process.env.ZF_HOST_DATA_DIR ? path.join(process.env.ZF_HOST_DATA_DIR, path.relative(deps.dataDir, p)) : p);
  const workDir = path.join(wsRoot, 'work');
  fs.mkdirSync(path.join(wsRoot, 'home'), { recursive: true });

  let pending: Array<NormalisedEvent | { kind: 'system.status' | 'system.followup'; text: string; by?: string }> = [];
  const all: NormalisedEvent[] = [];
  const stderrTail: string[] = [];
  let flushing = Promise.resolve(0);
  const flush = () => {
    if (!pending.length) return flushing;
    const batch = pending; pending = [];
    flushing = flushing.then(() => orch.recordEvents(runId, batch)).catch((e) => { log.warn('record events failed', { error: errMessage(e) }); return 0; });
    return flushing;
  };
  const status = (text: string) => pending.push({ kind: 'system.status', text });
  const timer = setInterval(() => void flush(), FLUSH_MS);

  let sandbox: Sandbox | undefined;
  let overlayRef: Overlay | undefined;
  let proxy: Awaited<ReturnType<typeof startEgressProxy>> | undefined;
  let cancelFlag = false, budgetHit = false;
  const cancelPoll = setInterval(() => { void orch.isCancelRequested(runId).then((c) => { if (c) cancelFlag = true; }).catch(() => undefined); }, 1500);

  try {
    /* ---------- workspace ---------- */
    status(`preparing workspace for ${plan.workItem.shortId} on ${plan.workItem.branch}`);
    const mat = materialiseSkills(plan.agent.harness.type, plan.skillFiles.map((s) => ({ name: s.name, files: s.files })));
    let cloneUrl: string | undefined;
    let remoteAuth: { url: string; token?: string } | undefined;
    if (plan.repo) {
      const forge = await deps.forges?.forRepo(plan.factory.id, plan.repo);
      if (forge && forge.kind !== 'local') {
        const cred = await forge.cloneAuth(plan.repo.owner, plan.repo.name);
        cloneUrl = cred.url || undefined;
        if (cred.url) remoteAuth = { url: cred.url, token: cred.token };
      } else cloneUrl = plan.repo.cloneUrl ?? undefined;
    }
    const ws = await prepareWorkspace({ dir: workDir, branch: plan.workItem.branch, defaultBranch: plan.repo?.defaultBranch ?? 'main', cloneUrl, auth: remoteAuth ? { token: remoteAuth.token } : undefined, exclude: [...mat.excludes, ...Object.values(MATERIALISE_TABLE).map((x) => `/${x.skillsDir}/`)] });
    if (!ws.usedGit) status('git is not installed on this machine: running in a plain folder (no branch, commit or push)');

    const write = (rel: string, content: string) => {
      const target = path.resolve(workDir, rel);
      if (!target.startsWith(path.resolve(workDir) + path.sep) && target !== path.resolve(workDir)) throw new Error(`refusing to write outside the workspace: ${rel}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    // Skills and tool config are an overlay for this run only: whatever the repository already has at those paths comes back
    // before anything is committed, and nothing (tokens in MCP config included) outlives the run.
    const journal = path.join(workDir, '.zerovity', 'run', 'overlay.json');
    const recovered = recoverOverlay(journal);
    if (recovered) status(`restored ${recovered} file(s) left by an interrupted run`);
    const overlay = new Overlay(workDir, journal);
    overlayRef = overlay;
    for (const [rel, c] of Object.entries(mat.files)) overlay.write(rel, c);
    write(INSTRUCTIONS_PATH, plan.instructions);
    write(RESULT_SCHEMA_PATH, plan.resultSchema);
    fs.rmSync(path.join(workDir, RESULT_PATH), { force: true });
    await restoreArtifacts(deps, plan, workDir);

    // context bundle: repo conventions are read from the working copy now that it exists
    const conv = REPO_CONVENTION_FILES.map((f) => ({ path: f, content: fs.existsSync(path.join(workDir, f)) ? fs.readFileSync(path.join(workDir, f), 'utf8') : '' }));
    const bundle = assembleContext({ ...plan.contextInput, extra: repoConventionItems(conv, plan.contextInput.workItem.repoKey ?? '') });
    fs.rmSync(path.join(workDir, '.zerovity', 'context'), { recursive: true, force: true });
    for (const [rel, c] of Object.entries(bundleToFiles(bundle))) write(rel, c);
    await deps.artifacts.put(`runs/${runId}/context.json`, JSON.stringify({ hash: bundle.bundleHash, tokens: bundle.tokens, budget: bundle.budget, trimmed: bundle.trimmed, report: bundle.report }, null, 1), 'application/json');
    status(`context bundle ${bundle.bundleHash.slice(0, 12)} · ${bundle.tokens} tokens · ${bundle.report.filter((r) => r.form !== 'dropped').length} items`);

    /* ---------- sandbox ---------- */
    if (deps.sandbox === 'docker') {
      const net = plan.runner.network;
      if (net.egress === 'allowlist' && !deps.docker?.network) proxy = await startEgressProxy(() => net.allow);
      // the agent runs as a non-root user that must own the workspace: use the worker's own uid, or hand the tree to 1000 when the worker is root
      const uid = process.getuid?.(), gid = process.getgid?.();
      const user = deps.docker?.user ?? (uid && uid !== 0 ? `${uid}:${gid ?? uid}` : '1000:1000');
      if (uid === 0) chownTree(wsRoot, 1000, 1000);
      sandbox = await DockerSandbox.create({ image: plan.runner.image, hostWorkRoot: toHost(wsRoot), hostHome: toHost(path.join(wsRoot, 'home')), resources: plan.runner.resources, egress: net.egress, network: deps.docker?.network, user, proxyUrl: proxy ? `http://${deps.docker?.proxyHost ?? 'host.docker.internal'}:${proxy.port}` : undefined });
    } else sandbox = new LocalSandbox(workDir);
    const workPath = sandbox.workPath;

    await orch.markRunStarted(runId, { contextBundleHash: bundle.bundleHash, baseSha: ws.baseSha });
    const base = ws.baseSha;
    const adapter = createAdapter(plan.agent.harness.type);
    const det = await adapter.detect();
    if (!det.installed) return fail(`${plan.agent.harness.type} CLI is not installed on this worker`, 'harness_missing');

    if (plan.runner.setupCommands.length && (deps.sandbox === 'docker' || deps.localSetup)) {
      for (const cmd of plan.runner.setupCommands) {
        status(`setup: ${cmd}`);
        const r = await sandbox.exec('sh', ['-c', cmd], { cwd: workPath, env: {}, timeoutMs: 15 * 60_000, idleMs: 10 * 60_000, onLine: (l) => pending.push({ kind: 'system.status', text: `setup> ${l.slice(0, 300)}` }), isCancelled: () => cancelFlag });
        if (r.exitCode !== 0) return fail(`setup command failed: ${cmd}`, 'setup_failed');
      }
    }

    /* ---------- run the harness ---------- */
    // the agent's git: factory identity, and none of the operator's credential helpers or global config
    const gitConfigHost = path.join(wsRoot, 'agent.gitconfig');
    fs.writeFileSync(gitConfigHost, '[safe]\n\tdirectory = *\n');
    const gitEnv = agentGitEnv(deps.sandbox === 'docker' ? '/workspace/agent.gitconfig' : gitConfigHost);
    const prefix = MATERIALISE_TABLE[plan.agent.harness.type].instructions === 'prompt-prefix';
    const spec: RunSpec = {
      runId, workItemId: plan.workItem.shortId, agent: plan.agent, prompt: prefix ? `${plan.instructions}\n\n---\n\n${plan.prompt}` : plan.prompt, worktreePath: workPath,
      env: plan.env, mcpServers: plan.mcpServers, resumeSessionId: plan.resumeSessionId, limits: { maxMinutes: plan.limits.maxMinutes, maxTokens: plan.limits.maxTokens }, extraAllowedShell: [],
    };
    const runCommand = async (cmd: CommandSpec, label: string): Promise<{ exitCode: number | null; timedOut: boolean; idle: boolean; cancelled: boolean }> => {
      for (const [rel, c] of Object.entries(cmd.files ?? {})) overlay.write(rel, c);
      status(label);
      return sandbox!.exec(cmd.cmd, cmd.args, {
        cwd: workPath, env: { ...cmd.env, ...gitEnv }, stdin: cmd.stdin, timeoutMs: plan.limits.maxMinutes * 60_000, idleMs: plan.limits.idleMinutes * 60_000,
        isCancelled: () => cancelFlag || budgetHit,
        onLine: (line, stream) => {
          if (stream === 'stderr') { stderrTail.push(redactText(line).slice(0, 300)); if (stderrTail.length > 25) stderrTail.shift(); return; }
          for (const e of adapter.parseLine(line, { cwd: workPath })) {
            all.push(e);
            pending.push(e);
            if (e.kind === 'usage') void orch.checkBudget(runId).then((b) => { if (b.exceeded) budgetHit = true; }).catch(() => undefined);
          }
        },
      });
    };

    let res = await runCommand(adapter.buildCommand(spec), `starting ${plan.agent.harness.type}${plan.agent.harness.model ? ` (${plan.agent.harness.model})` : ''}`);
    let sessionId = adapter.extractSessionId(all) ?? plan.resumeSessionId;

    // messages a person typed into the live run view are delivered as follow-ups in the same session
    const delivered = await deliverFollowups(deps, runId, async (msg) => {
      if (!adapter.sendFollowUp || !sessionId) return;
      pending.push({ kind: 'system.followup', text: msg });
      res = await runCommand(adapter.sendFollowUp(sessionId, msg, spec), 'follow-up message');
      sessionId = adapter.extractSessionId(all) ?? sessionId;
    });
    if (delivered) log.info('delivered follow-ups', { n: delivered });

    if (res.cancelled && budgetHit) return await finishWith({ status: 'budget', sessionId, exitReason: 'budget' });
    if (res.cancelled) return await finishWith({ status: 'cancelled', sessionId, exitReason: 'cancelled' });
    if (res.timedOut) return await finishWith({ status: 'timeout', sessionId, exitReason: 'max_run_minutes' });
    if (res.idle) return await finishWith({ status: 'timeout', sessionId, exitReason: 'idle_timeout' });

    /* ---------- result contract (spec 8.4) ---------- */
    const readResult = (): { ok: true; result: RunResult } | { ok: false; why: string } => {
      const f = path.join(workDir, RESULT_PATH);
      if (!fs.existsSync(f)) return { ok: false, why: 'result.json was not written' };
      try {
        const p = ResultSchema.safeParse(JSON.parse(fs.readFileSync(f, 'utf8')));
        return p.success ? { ok: true, result: p.data } : { ok: false, why: `result.json is invalid: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
      } catch (e) { return { ok: false, why: `result.json is not valid JSON: ${errMessage(e)}` }; }
    };
    let rr = readResult();
    let repairAttempted = false;
    if (!rr.ok && res.exitCode === 0 && adapter.sendFollowUp && sessionId) {
      repairAttempted = true;
      status(`${rr.why}; asking the agent to write it`);
      res = await runCommand(adapter.sendFollowUp(sessionId, REPAIR_PROMPT, spec), 'repair follow-up');
      rr = readResult();
    }
    if (!rr.ok) {
      const tail = stderrTail.slice(-3).join(' | ');
      return await finishWith({ status: 'failed', sessionId, exitReason: res.exitCode ? `harness_exit_${res.exitCode}` : 'no_result', error: `${rr.why}${res.exitCode ? ` (exit ${res.exitCode})` : ''}${tail ? `: ${tail}` : ''}`, repairAttempted });
    }
    return await finishWith({ status: 'done', result: rr.result, sessionId, repairAttempted });

    /* ---------- post processing: artifacts, git, diff ---------- */
    async function finishWith(o: RunOutcome): Promise<RunOutcome> {
      overlay.restore(); // before the commit: skills and tool config must never be committed or left behind
      await uploadOut(deps, runId, workDir);
      if (o.status === 'done' && o.result && ws.usedGit) {
        try {
          if (plan.run.phase === 'SPEC') {
            const spec = path.join(workDir, OUT_DIR, 'spec.md');
            if (fs.existsSync(spec)) write(plan.specFileName, fs.readFileSync(spec, 'utf8'));
          }
          const first = (o.result.summary || plan.run.phase).split('\n')[0].slice(0, 120);
          const c = await commitAll(workDir, `[zerovity:${plan.agent.name}] ${plan.run.phase}: ${first}`);
          o.headSha = c.sha;
          if (base) {
            const diff = await diffAgainst(workDir, base);
            if (diff) await deps.artifacts.put(`runs/${runId}/diff.patch`, diff, 'text/x-diff');
            const files = await changedFiles(workDir, base);
            o.result = { ...o.result, pathsTouched: [...new Set([...o.result.pathsTouched, ...files])] };
            const hc = await humanCommits(workDir, base);
            if (hc > 0) await markHuman(orch, plan.workItem.id);
          }
          if (ws.hasRemote || (cloneUrl && plan.repo)) {
            let push: { url: string; token?: string } | undefined;
            if (plan.repo) { const forge = await deps.forges?.forRepo(plan.factory.id, plan.repo); if (forge && forge.kind !== 'local') { const cred = await forge.cloneAuth(plan.repo.owner, plan.repo.name); if (cred.url) push = { url: cred.url, token: cred.token }; } }
            const pushed = await pushBranch(workDir, plan.workItem.branch, push);
            if (pushed) status(`pushed ${plan.workItem.branch}`);
          }
        } catch (e) {
          log.error('git post-processing failed', { error: errMessage(e) });
          return { ...o, status: 'failed', exitReason: 'git_failed', error: redactText(errMessage(e)) };
        }
      }
      return o;
    }

    function fail(msg: string, reason: string): RunOutcome {
      return { status: 'failed', exitReason: reason, error: msg };
    }
  } catch (e) {
    const msg = redactText(errMessage(e));
    log.error('run crashed', { error: msg });
    return { status: 'failed', exitReason: 'worker_error', error: msg };
  } finally {
    clearInterval(timer);
    clearInterval(cancelPoll);
    overlayRef?.restore();
    await flush();
    await flushing;
    await sandbox?.destroy().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
  }
}

async function markHuman(orch: Orchestrator, workItemId: string) {
  const [w] = await orch.db.select().from(t.workItems).where(eq(t.workItems.id, workItemId));
  if (w) await orch.db.update(t.workItems).set({ flags: { ...(w.flags as object), humanCommits: true } }).where(eq(t.workItems.id, workItemId));
}

/** Upload everything under .zerovity/out so the UI can show specs, logs, screenshots and evidence. */
async function uploadOut(deps: ExecutorDeps, runId: string, workDir: string) {
  const root = path.join(workDir, OUT_DIR);
  if (!fs.existsSync(root)) return;
  const walk = async (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs, r);
      else if (fs.statSync(abs).size <= MAX_ARTIFACT) {
        const buf = fs.readFileSync(abs);
        const text = /\.(md|txt|log|json|ya?ml|patch|diff|csv)$/i.test(e.name);
        await deps.artifacts.put(`runs/${runId}/out/${r}`, text ? Buffer.from(redactText(buf.toString('utf8'))) : buf);
      }
    }
  };
  await walk(root, '');
}

/** A fresh workspace (new machine, wiped disk) still gets earlier phases' outputs back. */
async function restoreArtifacts(deps: ExecutorDeps, plan: RunPlan, workDir: string) {
  const out = path.join(workDir, OUT_DIR);
  const runs = await deps.orch.db.select().from(t.runs).where(and(eq(t.runs.workItemId, plan.workItem.id), inArray(t.runs.status, ['done']))).orderBy(desc(t.runs.createdAt));
  const seen = new Set<string>();
  for (const r of runs) {
    for (const a of (r.resultJson as { artifacts?: Array<{ path: string }> } | null)?.artifacts ?? []) {
      const rel = a.path.replace(/^\.zerovity\/out\//, '');
      if (seen.has(rel) || fs.existsSync(path.join(out, rel))) { seen.add(rel); continue; }
      seen.add(rel);
      const buf = await deps.artifacts.get(`runs/${r.id}/out/${rel}`);
      if (buf) { fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), buf); }
    }
  }
}

async function deliverFollowups(deps: ExecutorDeps, runId: string, send: (msg: string) => Promise<void>): Promise<number> {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const [row] = await deps.orch.db.select().from(t.kv).where(eq(t.kv.key, `followup:${runId}`));
    const msgs = (row?.value as string[] | undefined) ?? [];
    if (!msgs.length) break;
    await deps.orch.db.delete(t.kv).where(eq(t.kv.key, `followup:${runId}`));
    for (const m of msgs) { await send(m); n++; }
  }
  return n;
}

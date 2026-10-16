import type { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ResultSchema, resultJsonSchema, redactText, type NormalisedEvent } from '@zerovity/core';
import { loadDir } from '@zerovity/definition';
import { validateFactory, materialiseSkills, MATERIALISE_TABLE, effectiveSkills, type SkillSources } from '@zerovity/skills';
import { createAdapter, buildPreamble, INSTRUCTIONS_PATH, RESULT_PATH, RESULT_SCHEMA_PATH, REPAIR_PROMPT, type RunSpec } from '@zerovity/harness';
import { parseFrontmatter, AgentFrontmatterSchema } from '@zerovity/definition';
import { LocalSandbox } from '@zerovity/worker';
import { localRegistry, green, red, dim, cyan, yellow } from '../util';

/** `zf run`: execute one agent through one harness against a repository, locally, without a server (spec 15 M3). */
export function registerRun(p: Command) {
  p.command('run')
    .description('Run one agent locally: materialise skills, write the preamble and context, run the harness, show events, print the result')
    .requiredOption('--agent <name>', 'agent name from the definition or its packs')
    .option('--harness <type>', 'claude-code | codex | copilot | fake (default: the agent\'s own)')
    .option('--repo <path>', 'repository folder to work in (a throwaway copy is made unless --in-place)', '.')
    .option('--prompt <text>', 'what to do', 'Do the work described in your role.')
    .option('--definition <path>', 'definition folder (default: --repo if it has zerovity.factory.yaml, else the 01 example)')
    .option('--model <id>', 'model override')
    .option('--in-place', 'run directly in --repo instead of a copy')
    .option('--max-minutes <n>', 'time limit', '20')
    .option('--context <file...>', 'markdown files to put in CONTEXT.md')
    .action(async (o: { agent: string; harness?: string; repo: string; prompt: string; definition?: string; model?: string; inPlace?: boolean; maxMinutes: string; context?: string[] }) => {
      const repo = path.resolve(o.repo);
      const root = (await import('../root')).findRepoRootSync();
      const defDir = path.resolve(o.definition ?? (fs.existsSync(path.join(repo, 'zerovity.factory.yaml')) ? repo : path.join(root, 'examples', '01-single-repo')));
      const files = loadDir(defDir);
      const reg = localRegistry(defDir);
      const v = await validateFactory(files, reg);
      if (!v.ok && v.issues.some((i) => i.severity === 'error')) { for (const i of v.issues.filter((x) => x.severity === 'error')) console.error(red(`${i.file}:${i.line ?? ''} ${i.message}`)); throw new Error('definition is not valid; run zf validate'); }
      // agent from the definition, factory overrides, or a pack
      let body = '', fm: ReturnType<typeof AgentFrontmatterSchema.parse> | undefined;
      const own = v.definition?.agents[o.agent];
      if (own) { fm = own.fm; body = own.body; }
      else for (const pk of v.packs) if (pk.agents[o.agent]) { const f = parseFrontmatter(pk.agents[o.agent], o.agent); fm = AgentFrontmatterSchema.parse(f.data); body = f.body; }
      if (!fm) throw new Error(`agent "${o.agent}" not found in ${defDir} or its packs`);
      const factorySkills: SkillSources['factory'] = {}, agentSkills: SkillSources['agent'] = {};
      for (const [pth, c] of Object.entries(files)) {
        let m = /^skills\/([^/]+)\/(.+)$/.exec(pth); if (m) (factorySkills[m[1]] ??= {})[m[2]] = c;
        m = /^agents\/([^/]+)\/skills\/([^/]+)\/(.+)$/.exec(pth); if (m) ((agentSkills[m[1]] ??= {})[m[2]] ??= {})[m[3]] = c;
      }
      const eff = effectiveSkills(o.agent, body, fm.skills, { packs: v.packs, factory: factorySkills, agent: agentSkills });
      const harnessType = (o.harness ?? fm.harness?.type ?? v.definition?.factory.agentDefaults.harness?.type ?? 'claude-code') as 'claude-code' | 'codex' | 'copilot' | 'fake';

      // working copy
      const work = o.inPlace ? repo : fs.mkdtempSync(path.join(os.tmpdir(), 'zf-run-'));
      if (!o.inPlace) {
        fs.cpSync(repo, work, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(s) });
        if (spawnSync('git', ['--version']).status === 0 && !fs.existsSync(path.join(work, '.git'))) { for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=zf', '-c', 'user.email=zf@local', 'commit', '-qm', 'snapshot', '--allow-empty']]) spawnSync('git', a, { cwd: work }); }
      }
      const adapter = createAdapter(harnessType);
      const det = await adapter.detect();
      if (!det.installed) throw new Error(`${harnessType} is not installed on this machine`);
      console.log(`${cyan('agent')} ${o.agent}  ${cyan('harness')} ${harnessType}${det.version ? ` ${det.version}` : ''}  ${cyan('skills')} ${eff.skills.map((s) => s.name).join(', ') || 'none'}  ${cyan('workdir')} ${work}`);

      const w = (rel: string, content: string) => { const t = path.join(work, rel); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, content); };
      const mat = materialiseSkills(harnessType, eff.skills.map((s) => ({ name: s.name, files: s.files })));
      for (const [rel, c] of Object.entries(mat.files)) w(rel, c);
      if (fs.existsSync(path.join(work, '.git'))) { const ex = path.join(work, '.git', 'info', 'exclude'); fs.appendFileSync(ex, '\n' + mat.excludes.join('\n') + '\n'); }
      const instructions = buildPreamble({ agent: { name: o.agent, body, outputs: fm.outputs, skills: eff.skills }, phase: fm.phase, workItemId: 'LOCAL-1', title: o.prompt.slice(0, 80) });
      w(INSTRUCTIONS_PATH, instructions);
      w(RESULT_SCHEMA_PATH, JSON.stringify(resultJsonSchema(), null, 2));
      fs.rmSync(path.join(work, RESULT_PATH), { force: true });
      const ctxParts = [`# Context for LOCAL-1\nAgent: ${o.agent} · phase ${fm.phase}\n`, ...(o.context ?? []).map((f) => `## ${path.basename(f)}\n\n${fs.readFileSync(f, 'utf8')}`)];
      for (const rel of ['AGENTS.md', 'CLAUDE.md']) if (fs.existsSync(path.join(work, rel))) ctxParts.push(`## ${rel} (repo conventions)\n\n${fs.readFileSync(path.join(work, rel), 'utf8').slice(0, 8000)}`);
      w('.zerovity/context/CONTEXT.md', ctxParts.join('\n\n'));

      const prefix = MATERIALISE_TABLE[harnessType].instructions === 'prompt-prefix';
      const spec: RunSpec = { runId: 'local', workItemId: 'LOCAL-1', agent: { name: o.agent, phase: fm.phase, body, skills: eff.skills, outputs: fm.outputs, harness: { type: harnessType, model: o.model ?? fm.harness?.model, reasoning: fm.harness?.reasoning }, mcpServers: [] }, prompt: prefix ? `${instructions}\n\n---\n\n${o.prompt}` : o.prompt, worktreePath: work, env: Object.fromEntries(Object.entries(process.env).filter(([k, val]) => val !== undefined && /^(ANTHROPIC_|OPENAI_|CODEX_|COPILOT_|GH_TOKEN|CLAUDE_|AWS_|GOOGLE_|CLOUD_ML|ZF_FAKE)/.test(k))) as Record<string, string>, limits: { maxMinutes: Number(o.maxMinutes), maxTokens: 2_000_000 } };

      const events: NormalisedEvent[] = [];
      const sb = new LocalSandbox(work);
      const exec = async (cmd: ReturnType<typeof adapter.buildCommand>) => {
        for (const [rel, c] of Object.entries(cmd.files ?? {})) w(rel, c);
        return sb.exec(cmd.cmd, cmd.args, { cwd: work, env: cmd.env, timeoutMs: Number(o.maxMinutes) * 60_000, idleMs: 10 * 60_000, isCancelled: () => false, onLine: (line, stream) => { if (stream === 'stderr') return; for (const e of adapter.parseLine(line, { cwd: work })) { events.push(e); show(e); } } });
      };
      const res = await exec(adapter.buildCommand(spec));
      let rf = path.join(work, RESULT_PATH);
      const sid = adapter.extractSessionId(events);
      if (!fs.existsSync(rf) && res.exitCode === 0 && adapter.sendFollowUp && sid) { console.log(yellow('result.json missing: asking the agent to write it')); await exec(adapter.sendFollowUp(sid, REPAIR_PROMPT, spec)); }
      rf = path.join(work, RESULT_PATH);
      const u = adapter.extractUsage(events);
      console.log(dim(`\nusage: in ${u.inputTokens} · out ${u.outputTokens} · cached ${u.cachedTokens}${u.costUsd !== undefined ? ` · $${u.costUsd.toFixed(4)}` : ''}${u.premiumRequests ? ` · ${u.premiumRequests} premium request(s)` : ''}  session ${sid ?? 'n/a'}`));
      if (!fs.existsSync(rf)) { console.error(red('FAILED: no result.json (reason: no_result)')); process.exitCode = 1; return; }
      const parsed = ResultSchema.safeParse(JSON.parse(fs.readFileSync(rf, 'utf8')));
      if (!parsed.success) { console.error(red(`FAILED: result.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)); process.exitCode = 1; return; }
      console.log(green(`\nresult: ${parsed.data.status}`) + `  ${redactText(parsed.data.summary)}`);
      for (const q of parsed.data.questions) console.log(yellow(`  ? ${q.text}`));
      console.log(dim(`outputs: ${path.join(work, '.zerovity', 'out')}`));
      process.exitCode = parsed.data.status === 'failed' ? 1 : 0;
    });
}

function show(e: NormalisedEvent) {
  switch (e.kind) {
    case 'session.started': return console.log(dim(`session ${e.sessionId}${e.model ? ` · ${e.model}` : ''}`));
    case 'message.assistant': return console.log(`${cyan('▍')} ${e.text.split('\n')[0].slice(0, 200)}`);
    case 'command.run': return console.log(dim(`  $ ${e.command.slice(0, 120)}${e.exitCode !== undefined ? ` (exit ${e.exitCode})` : ''}`));
    case 'file.changed': return console.log(dim(`  ${e.op === 'add' ? '+' : e.op === 'delete' ? '-' : '~'} ${e.path}`));
    case 'error': return console.log(red(`  error: ${e.message.slice(0, 200)}`));
    default: return;
  }
}

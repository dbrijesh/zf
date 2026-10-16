import { parse as parseYamlText } from 'yaml';
import { err, warn, hasErrors, type Issue } from './issues';
import { parseYaml, checkSchema, posOf, type ParsedYaml } from './yaml';
import { parseFrontmatter } from './frontmatter';
import {
  FactorySchema, AgentFrontmatterSchema, GatesFileSchema, AutomationFrontmatterSchema, RunnerSchema, ScorerFrontmatterSchema, ContextFileSchema, LockSchema,
  type FactoryDoc, type AgentFrontmatter, type GatesFile, type AutomationFrontmatter, type RunnerDef, type ScorerFrontmatter, type ContextFile, type LockFile,
} from './schemas';
import { tryParsePolicy } from './policy';
import { collectSecretRefs } from './secrets';

export type Files = Record<string, string>;

export const AGENT_BODY_MAX_LINES = 60;
export const AGENT_DESC_MAX_CHARS = 200;
export const BUILTIN_RUNNERS = ['default'];
export const BUILTIN_AGENTS = ['foreman'];
export const BUILTIN_GATES = ['buildApproval', 'dbReview', 'specApproval'];

export interface AgentDef { name: string; file: string; fm: AgentFrontmatter; body: string; ownSkills: string[]; yaml?: ParsedYaml }
export interface SkillDir { name: string; scope: 'factory' | 'agent'; agent?: string; dir: string; files: string[] }
export interface AutomationDef { name: string; file: string; fm: AutomationFrontmatter; body: string }
export interface ScorerDef { name: string; file: string; fm: ScorerFrontmatter; body: string }
export interface ContextDef { name: string; file: string; fm: ContextFile; body: string }

export interface Definition {
  factory: FactoryDoc;
  agents: Record<string, AgentDef>;
  skillDirs: SkillDir[];
  automations: Record<string, AutomationDef>;
  runners: Record<string, RunnerDef>;
  scorers: Record<string, ScorerDef>;
  context: Record<string, ContextDef>;
  gates: GatesFile;
  lock?: LockFile;
}

export interface ValidateOptions {
  /** skills offered by installed packs: pack name -> skill names. When omitted, pack skills are not checked. */
  packSkills?: Record<string, string[]>;
  /** agents offered by installed packs (so automations can name them) */
  packAgents?: Record<string, string[]>;
}

export interface ValidateResult { definition?: Definition; issues: Issue[]; ok: boolean }

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const KNOWN_ROOT = [/^zerovity\.factory\.yaml$/, /^zerovity\.lock$/, /^agents\//, /^skills\//, /^context\//, /^automations\//, /^runners\//, /^scorers\//, /^policies\//, /^README/i, /^\./];

export function validateDefinition(files: Files, opts: ValidateOptions = {}): ValidateResult {
  const issues: Issue[] = [];
  const paths = Object.keys(files).sort();

  /* ---- factory ---- */
  const FF = 'zerovity.factory.yaml';
  if (!(FF in files)) {
    issues.push(err('missing_file', `${FF} is required`, FF));
    return { issues, ok: false };
  }
  const fy = parseYaml(files[FF], FF);
  issues.push(...fy.issues);
  if (!fy.parsed) return { issues, ok: false };
  const fc = checkSchema(FactorySchema, fy.parsed, FF);
  issues.push(...fc.issues);
  if (!fc.value) return { issues, ok: false };
  const factory = fc.value;

  const secretsDeclared = new Set(factory.secrets);
  for (const ref of collectSecretRefs(factory)) {
    if (!secretsDeclared.has(ref)) issues.push(err('undeclared_secret', `\${secret:${ref}} is used but "${ref}" is not listed under secrets`, FF, posOf(fy.parsed, ['secrets'])));
  }
  for (const m of paths) if (!KNOWN_ROOT.some((r) => r.test(m))) issues.push(warn('unknown_file', `Unrecognised file ${m} is ignored`, m));

  /* ---- runners ---- */
  const runners: Record<string, RunnerDef> = {};
  for (const p of paths.filter((x) => /^runners\/[^/]+\.ya?ml$/.test(x))) {
    const n = p.replace(/^runners\/|\.ya?ml$/g, '');
    if (!NAME_RE.test(n)) issues.push(err('bad_name', `Runner name "${n}" must be lowercase-hyphen`, p));
    const y = parseYaml(files[p], p);
    issues.push(...y.issues);
    if (!y.parsed) continue;
    const c = checkSchema(RunnerSchema, y.parsed, p);
    issues.push(...c.issues);
    if (c.value) runners[n] = c.value;
  }
  const runnerExists = (n: string) => BUILTIN_RUNNERS.includes(n) || n in runners;
  const dr = factory.agentDefaults.runner;
  if (dr && !runnerExists(dr)) issues.push(err('unknown_runner', `Runner "${dr}" is not defined in runners/`, FF, posOf(fy.parsed, ['agentDefaults', 'runner'])));

  /* ---- gates ---- */
  let gates = GatesFileSchema.parse({});
  const GF = 'policies/gates.yaml';
  if (GF in files) {
    const y = parseYaml(files[GF], GF);
    issues.push(...y.issues);
    if (y.parsed) {
      const c = checkSchema(GatesFileSchema, y.parsed, GF);
      issues.push(...c.issues);
      if (c.value) {
        gates = c.value;
        const gateNames = new Set([...BUILTIN_GATES, ...Object.keys(c.value.gates).filter((k) => !['questionTimeoutHours', 'handoff', 'riskOverrides', 'maxRevisionLoops'].includes(k))]);
        c.value.gates.riskOverrides.forEach((ro, i) => {
          const r = tryParsePolicy(ro.if);
          if (!r.ok) issues.push(err('policy_syntax', `Invalid policy expression: ${r.message} (col ${r.col})`, GF, posOf(y.parsed!, ['gates', 'riskOverrides', i, 'if'])));
          ro.add.forEach((g, j) => {
            if (!gateNames.has(g)) issues.push(err('unknown_gate', `Gate "${g}" is not defined`, GF, posOf(y.parsed!, ['gates', 'riskOverrides', i, 'add', j])));
          });
        });
      }
    }
  }

  /* ---- skills (directory presence only; content lint lives in @zerovity/skills) ---- */
  const skillDirs: SkillDir[] = [];
  const dirFiles = new Map<string, string[]>();
  for (const p of paths) {
    const m = /^(skills\/[^/]+|agents\/[^/]+\/skills\/[^/]+)\/(.+)$/.exec(p);
    if (m) dirFiles.set(m[1], [...(dirFiles.get(m[1]) ?? []), m[2]]);
  }
  for (const [dir, fl] of dirFiles) {
    const parts = dir.split('/');
    const name = parts[parts.length - 1];
    const agent = parts[0] === 'agents' ? parts[1] : undefined;
    if (!fl.includes('SKILL.md')) {
      issues.push(err('skill_missing_file', `Skill folder ${dir} has no SKILL.md`, dir));
      continue;
    }
    if (!NAME_RE.test(name)) issues.push(err('bad_name', `Skill name "${name}" must be lowercase-hyphen`, `${dir}/SKILL.md`));
    skillDirs.push({ name, scope: agent ? 'agent' : 'factory', agent, dir, files: fl });
  }

  /* ---- agents ---- */
  const agents: Record<string, AgentDef> = {};
  const agentNames = new Set<string>();
  for (const p of paths) {
    const m = /^agents\/([^/]+)\//.exec(p);
    if (m) agentNames.add(m[1]);
  }
  for (const n of agentNames) {
    const file = `agents/${n}/agent.md`;
    if (!NAME_RE.test(n)) issues.push(err('bad_name', `Agent name "${n}" must be lowercase-hyphen`, `agents/${n}`));
    if (!(file in files)) {
      issues.push(warn('agent_missing_file', `agents/${n}/ has no agent.md`, `agents/${n}`));
      continue;
    }
    const fm = parseFrontmatter(files[file], file);
    issues.push(...fm.issues);
    if (!fm.yaml) {
      issues.push(err('frontmatter', 'agent.md needs YAML frontmatter (description, phase, ...)', file, { line: 1 }));
      continue;
    }
    const c = checkSchema(AgentFrontmatterSchema, fm.yaml, file);
    issues.push(...c.issues);
    if (!c.value) continue;
    if (c.value.description.length > AGENT_DESC_MAX_CHARS) issues.push(err('agent_description_long', `description is ${c.value.description.length} chars (max ${AGENT_DESC_MAX_CHARS})`, file, posOf(fm.yaml, ['description'])));
    if (fm.bodyLines > AGENT_BODY_MAX_LINES) issues.push(err('agent_body_long', `body is ${fm.bodyLines} lines (max ${AGENT_BODY_MAX_LINES}); move procedures into skills`, file, { line: fm.bodyStartLine + AGENT_BODY_MAX_LINES }));
    agents[n] = { name: n, file, fm: c.value, body: fm.body, ownSkills: skillDirs.filter((s) => s.agent === n).map((s) => s.name), yaml: fm.yaml };
  }

  const packSkillSet = new Set<string>();
  for (const pk of factory.packs) for (const s of opts.packSkills?.[pk.name] ?? []) packSkillSet.add(s);
  const packsChecked = !factory.packs.length || !!opts.packSkills;
  const factorySkillSet = new Set(skillDirs.filter((s) => s.scope === 'factory').map((s) => s.name));
  for (const a of Object.values(agents)) {
    const ys = a.yaml!;
    a.fm.skills.forEach((s, i) => {
      const known = packSkillSet.has(s) || factorySkillSet.has(s) || a.ownSkills.includes(s);
      if (!known && packsChecked) issues.push(err('unknown_skill', `Skill "${s}" does not resolve from agent, factory or installed packs`, a.file, posOf(ys, ['skills', i])));
      else if (!known) issues.push(warn('skill_unchecked', `Skill "${s}" could not be checked (pack contents unavailable)`, a.file, posOf(ys, ['skills', i])));
    });
    if (a.fm.runner && !runnerExists(a.fm.runner)) issues.push(err('unknown_runner', `Runner "${a.fm.runner}" is not defined`, a.file, posOf(ys, ['runner'])));
    a.fm.mcpServers.forEach((m, i) => {
      if (!(m in factory.mcpServers)) issues.push(err('unknown_mcp', `MCP server "${m}" is not declared in zerovity.factory.yaml`, a.file, posOf(ys, ['mcpServers', i])));
    });
    a.fm.secrets.forEach((s, i) => {
      if (!secretsDeclared.has(s)) issues.push(err('undeclared_secret', `Secret "${s}" is not declared in zerovity.factory.yaml`, a.file, posOf(ys, ['secrets', i])));
    });
  }

  /* ---- automations ---- */
  const automations: Record<string, AutomationDef> = {};
  const knownAgents = new Set([...BUILTIN_AGENTS, ...Object.keys(agents), ...Object.values(opts.packAgents ?? {}).flat()]);
  for (const k of Object.keys(factory.agentOverrides)) {
    if (!knownAgents.has(k)) issues.push(err('unknown_agent', `agentOverrides.${k}: agent does not exist in the factory or its packs`, FF, posOf(fy.parsed, ['agentOverrides', k])));
  }
  const repoSlugs = new Set(factory.repositories.map((r) => `${r.owner}/${r.name}`));
  for (const p of paths.filter((x) => /^automations\/[^/]+\/automation\.md$/.test(x))) {
    const n = p.split('/')[1];
    const fm = parseFrontmatter(files[p], p);
    issues.push(...fm.issues);
    if (!fm.yaml) { issues.push(err('frontmatter', 'automation.md needs YAML frontmatter', p, { line: 1 })); continue; }
    const c = checkSchema(AutomationFrontmatterSchema, fm.yaml, p);
    issues.push(...c.issues);
    if (!c.value) continue;
    if (!knownAgents.has(c.value.agent)) issues.push(err('unknown_agent', `Agent "${c.value.agent}" does not exist`, p, posOf(fm.yaml, ['agent'])));
    c.value.triggers.forEach((t, i) => {
      if (t.provider === 'github') for (const [j, r] of (t.filter?.repos ?? []).entries()) if (!repoSlugs.has(r)) issues.push(warn('unknown_repo', `Repository "${r}" is not listed under repositories`, p, posOf(fm.yaml!, ['triggers', i, 'filter', 'repos', j])));
      if (t.provider === 'schedule' && !validCron(t.cron)) issues.push(err('bad_cron', `"${t.cron}" is not a valid 5-field cron expression`, p, posOf(fm.yaml!, ['triggers', i, 'cron'])));
    });
    automations[n] = { name: n, file: p, fm: c.value, body: fm.body };
  }

  /* ---- scorers ---- */
  const scorers: Record<string, ScorerDef> = {};
  for (const p of paths.filter((x) => /^scorers\/[^/]+\/scorer\.md$/.test(x))) {
    const n = p.split('/')[1];
    const fm = parseFrontmatter(files[p], p);
    issues.push(...fm.issues);
    if (!fm.yaml) { issues.push(err('frontmatter', 'scorer.md needs YAML frontmatter', p, { line: 1 })); continue; }
    const c = checkSchema(ScorerFrontmatterSchema, fm.yaml, p);
    issues.push(...c.issues);
    if (!c.value) continue;
    for (const [i, l] of c.value.passLabels.entries()) if (!c.value.labels.includes(l)) issues.push(err('bad_label', `passLabel "${l}" is not in labels`, p, posOf(fm.yaml, ['passLabels', i])));
    scorers[n] = { name: n, file: p, fm: c.value, body: fm.body };
  }

  /* ---- context ---- */
  const context: Record<string, ContextDef> = {};
  for (const p of paths.filter((x) => /^context\/[^/]+\.(md|ya?ml)$/.test(x))) {
    const n = p.replace(/^context\/|\.(md|ya?ml)$/g, '');
    if (p.endsWith('.md')) {
      const fm = parseFrontmatter(files[p], p);
      issues.push(...fm.issues);
      const y = fm.yaml ?? parseYaml('{}', p).parsed!;
      const c = checkSchema(ContextFileSchema, y, p);
      issues.push(...c.issues);
      if (c.value) context[n] = { name: n, file: p, fm: c.value, body: fm.body };
    } else {
      const y = parseYaml(files[p], p);
      issues.push(...y.issues);
      if (!y.parsed) continue;
      const c = checkSchema(ContextFileSchema, y.parsed, p);
      issues.push(...c.issues);
      if (c.value) context[n] = { name: n, file: p, fm: c.value, body: c.value.body ?? '' };
    }
  }

  /* ---- lock ---- */
  let lock: LockFile | undefined;
  if ('zerovity.lock' in files) {
    const y = parseYaml(files['zerovity.lock'], 'zerovity.lock');
    issues.push(...y.issues);
    if (y.parsed) {
      const c = checkSchema(LockSchema, y.parsed, 'zerovity.lock');
      issues.push(...c.issues);
      lock = c.value;
      if (lock) for (const pk of factory.packs) if (!lock.packs.some((l) => l.name === pk.name)) issues.push(warn('lock_missing', `Pack "${pk.name}" is not pinned in zerovity.lock (run: zf pack lock)`, 'zerovity.lock'));
    }
  } else if (factory.packs.length) issues.push(warn('lock_missing', 'Packs are declared but zerovity.lock does not exist (run: zf pack lock)', 'zerovity.lock'));

  if (!Object.keys(agents).length && !factory.packs.length) issues.push(warn('no_agents', 'No agents defined and no packs installed', 'agents'));

  const definition: Definition = { factory, agents, skillDirs, automations, runners, scorers, context, gates, lock };
  return { definition: hasErrors(issues) ? undefined : definition, issues, ok: !hasErrors(issues) };
}

export function validCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return parts.every((f, i) =>
    f.split(',').every((seg) => {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(seg);
      if (!m) return false;
      if (m[1] !== '*') {
        const [a, b] = m[1].split('-').map(Number);
        if (a < ranges[i][0] || (b ?? a) > ranges[i][1] || (b !== undefined && b < a)) return false;
      }
      return true;
    }),
  );
}

/** Parse a YAML string without schema checks (used by helper tooling). */
export const loadYaml = (s: string): unknown => parseYamlText(s);


/** Does a 5-field cron expression fire at this minute (local time of `d`)? Day-of-month and day-of-week are OR-ed when both are restricted, like Vixie cron. */
export function cronMatches(expr: string, d: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const field = (src: string, min: number, max: number): Set<number> => {
    const out = new Set<number>();
    for (const seg of src.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(seg);
      if (!m) continue;
      const step = m[2] ? Number(m[2]) : 1;
      const [a, b] = m[1] === '*' ? [min, max] : m[1].includes('-') ? m[1].split('-').map(Number) : [Number(m[1]), m[2] ? max : Number(m[1])];
      for (let v = a; v <= b; v += step) out.add(v);
    }
    return out;
  };
  const dow = field(f[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  const domRestricted = f[2] !== '*', dowRestricted = f[4] !== '*';
  const domOk = field(f[2], 1, 31).has(d.getDate()), dowOk = dow.has(d.getDay());
  const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
  return field(f[0], 0, 59).has(d.getMinutes()) && field(f[1], 0, 23).has(d.getHours()) && field(f[3], 1, 12).has(d.getMonth() + 1) && dayOk;
}

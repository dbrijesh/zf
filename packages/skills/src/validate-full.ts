import { validateDefinition, hasErrors, parseFrontmatter, type Files, type Issue, type ValidateResult } from '@zerovity/definition';
import { lintSkill, type SkillLintReport } from './lint';
import { effectiveSkills, type EffectiveSkills, type SkillSources } from './resolve';
import { loadLocked, type Pack, type PackRegistry } from './packs';
import type { SkillFiles } from './skill';
import { err, warn } from '@zerovity/definition';
import { parse as parseYamlText } from 'yaml';

export interface FullValidation extends ValidateResult {
  skillReports: SkillLintReport[];
  agentSkills: Record<string, EffectiveSkills>;
  packs: Pack[];
}

/** Everything `zf validate` checks: definition shape, cross-references, skill lint, pack lock integrity. */
export async function validateFactory(files: Files, registry?: PackRegistry): Promise<FullValidation> {
  // first pass to read the lock and factory.packs without pack knowledge
  const first = validateDefinition(files);
  let packs: Pack[] = [];
  const extra: Issue[] = [];
  if (registry && first.definition?.lock) {
    const r = await loadLocked(first.definition.lock, registry);
    packs = r.packs;
    for (const p of r.problems) extra.push(err('lock_mismatch', p, 'zerovity.lock'));
  } else if (registry) {
    // no lock: resolve ranges from the registry
    const f = (first.definition?.factory ?? tryFactoryPacks(files)) as { packs: Array<{ name: string; version: string }> };
    for (const want of f.packs) {
      const p = await registry.resolve(want.name, want.version);
      if (p) packs.push(p);
      else extra.push(err('pack_not_found', `Pack ${want.name}@${want.version} was not found in the registry`, 'zerovity.factory.yaml'));
    }
  }
  // include: on a pack entry keeps only the chosen skills (the installer lets people pick)
  const wantByPack = new Map((res0Packs(files)).map((p) => [p.name, p.include]));
  packs = packs.map((p) => { const inc = wantByPack.get(p.manifest.name); return inc?.length ? { ...p, skills: Object.fromEntries(Object.entries(p.skills).filter(([n]) => inc.includes(n))) } : p; });
  const packSkills = registry ? Object.fromEntries(packs.map((p) => [p.manifest.name, Object.keys(p.skills)])) : undefined;
  const packAgents = registry ? Object.fromEntries(packs.map((p) => [p.manifest.name, Object.keys(p.agents)])) : undefined;
  const res = validateDefinition(files, { packSkills, packAgents });
  const issues = [...res.issues, ...extra];

  // gather skill folders
  const factorySkills: Record<string, SkillFiles> = {};
  const agentSkillFiles: Record<string, Record<string, SkillFiles>> = {};
  for (const [p, c] of Object.entries(files)) {
    let m = /^skills\/([^/]+)\/(.+)$/.exec(p);
    if (m) (factorySkills[m[1]] ??= {})[m[2]] = c;
    m = /^agents\/([^/]+)\/skills\/([^/]+)\/(.+)$/.exec(p);
    if (m) ((agentSkillFiles[m[1]] ??= {})[m[2]] ??= {})[m[3]] = c;
  }
  const reports: SkillLintReport[] = [];
  const seen = new Set<string>();
  const lintAll = (set: Record<string, SkillFiles>, prefix: string) => {
    for (const [n, f] of Object.entries(set)) {
      if (!('SKILL.md' in f)) continue; // already reported by the definition validator
      const label = `${prefix}${n}`;
      if (seen.has(label)) continue;
      seen.add(label);
      const rep = lintSkill(f, label);
      reports.push(rep);
      issues.push(...rep.issues);
    }
  };
  lintAll(factorySkills, 'skills/');
  for (const [a, set] of Object.entries(agentSkillFiles)) lintAll(set, `agents/${a}/skills/`);
  for (const p of packs) for (const [n, f] of Object.entries(p.skills)) {
    const rep = lintSkill(f, `${p.manifest.name}/skills/${n}`);
    reports.push(rep);
    issues.push(...rep.issues.map((i) => ({ ...i, severity: i.severity === 'error' ? ('warning' as const) : i.severity }))); // pack content is the pack author's responsibility
  }

  // effective skill set + weight for each agent (factory agents and pack agents)
  const sources: SkillSources = { packs, factory: factorySkills, agent: agentSkillFiles };
  const agentSkills: Record<string, EffectiveSkills> = {};
  for (const [name, a] of Object.entries(res.definition?.agents ?? {})) {
    const eff = effectiveSkills(name, a.body, a.fm.skills, sources);
    agentSkills[name] = eff;
    for (const m of eff.missing) if (!issues.some((i) => i.code === 'unknown_skill' && i.message.includes(`"${m}"`))) issues.push(warn('skill_missing', `Skill "${m}" for agent ${name} did not resolve`, a.file));
  }
  for (const p of packs) for (const [name, content] of Object.entries(p.agents)) {
    if (agentSkills[name]) continue;
    const fm = parseFrontmatter(content, `${p.manifest.name}/agents/${name}/agent.md`);
    const listed = Array.isArray(fm.data.skills) ? (fm.data.skills as string[]) : [];
    agentSkills[name] = effectiveSkills(name, fm.body, listed, sources);
  }
  return { ...res, issues, ok: !hasErrors(issues), definition: hasErrors(issues) ? undefined : res.definition, skillReports: reports, agentSkills, packs };
}

function res0Packs(files: Files): Array<{ name: string; include?: string[] }> {
  try { const d = parseYamlText(files['zerovity.factory.yaml'] ?? '') as { packs?: Array<{ name: string; include?: string[] }> } | null; return d?.packs ?? []; } catch { return []; }
}

function tryFactoryPacks(files: Files): { packs: Array<{ name: string; version: string }> } {
  try {
    // tolerate a factory file that failed validation: best-effort regex-free parse
    const d = parseYamlText(files['zerovity.factory.yaml'] ?? '') as { packs?: Array<{ name: string; version?: string }> } | null;
    return { packs: (d?.packs ?? []).map((p) => ({ name: p.name, version: p.version ?? '*' })) };
  } catch {
    return { packs: [] };
  }
}

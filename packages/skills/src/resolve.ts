import { parseSkill, skillIndexLine, type Skill, type SkillFiles } from './skill';
import { agentWeight } from './lint';
import type { Pack } from './packs';

export type SkillLayer = 'pack' | 'factory' | 'agent';
export interface ResolvedSkill extends Skill {
  layer: SkillLayer;
  /** pack name, "factory", or "agent:<name>" */
  source: string;
  overrides?: SkillLayer[];
}

export interface SkillSources {
  /** installed packs, in `packs:` order (earlier = lower precedence) */
  packs: Pack[];
  /** skills/<name>/... in the factory definition */
  factory: Record<string, SkillFiles>;
  /** agents/<agent>/skills/<name>/... */
  agent: Record<string, Record<string, SkillFiles>>;
}

/** Build the full precedence map for one agent: pack < factory < agent; later wins on a clash (spec 7.3). */
export function resolveAll(agentName: string, src: SkillSources): Map<string, ResolvedSkill> {
  const out = new Map<string, ResolvedSkill>();
  const put = (files: SkillFiles, layer: SkillLayer, source: string, label: string) => {
    const { skill } = parseSkill(files, label);
    if (!skill) return;
    const prev = out.get(skill.name);
    out.set(skill.name, { ...skill, layer, source, overrides: prev ? [...(prev.overrides ?? []), prev.layer] : undefined });
  };
  for (const p of src.packs) for (const [n, f] of Object.entries(p.skills)) put(f, 'pack', p.manifest.name, `${p.manifest.name}/skills/${n}`);
  for (const [n, f] of Object.entries(src.factory)) put(f, 'factory', 'factory', `skills/${n}`);
  for (const [n, f] of Object.entries(src.agent[agentName] ?? {})) put(f, 'agent', `agent:${agentName}`, `agents/${agentName}/skills/${n}`);
  return out;
}

export interface EffectiveSkills {
  skills: ResolvedSkill[];
  missing: string[];
  weight: ReturnType<typeof agentWeight>;
  index: string;
}

/** Effective skill set for an agent: the skills it names plus the ones only it owns. */
export function effectiveSkills(agentName: string, agentBody: string, listed: string[], src: SkillSources): EffectiveSkills {
  const all = resolveAll(agentName, src);
  const own = Object.keys(src.agent[agentName] ?? {});
  const names = [...new Set([...listed, ...own])];
  const skills: ResolvedSkill[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const s = all.get(n);
    if (s) skills.push(s);
    else missing.push(n);
  }
  return { skills, missing, weight: agentWeight(agentBody, skills), index: skills.map(skillIndexLine).join('\n') };
}

/** Skill usage across agents, for the Skills Library "used by" column. */
export function usedBy(agents: Record<string, { skills: string[] }>): Record<string, string[]> {
  const r: Record<string, string[]> = {};
  for (const [a, def] of Object.entries(agents)) for (const s of def.skills) (r[s] ??= []).push(a);
  return r;
}

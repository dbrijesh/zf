import { redactText, estimateTokens } from '@zerovity/core';
import { err, warn, type Issue } from '@zerovity/definition';
import { parseSkill, type Skill, type SkillFiles } from './skill';

export const SKILL_LIMITS = { bodyLines: 150, bodyTokens: 2000, description: 300, produces: 3 } as const;

const WHEN_RE = /\b(use|used|using)\b[^.]*\b(when|for|in|after|before|if|first|as|to|at|during)\b|\bwhen\b|\bbefore\b|\bafter\b/i;
const TOOL_NAMES = /\b(AskUserQuestion|TodoWrite|WebFetch|WebSearch|NotebookEdit|ExitPlanMode|MultiEdit|apply_patch|str_replace_editor|str_replace_based_edit_tool)\b|\bBash\(|\b(Read|Edit|Write|Grep|Glob|Bash) tool\b/;
const ABS_PATH = /(^|[\s"'`(=])(\/(home|Users|etc|var|opt|usr|root|tmp|mnt|srv)\/[^\s"'`)]*|[A-Za-z]:\\[^\s"'`)]*)/m;
const NET_CALL = /\b(curl|wget|nc|ncat|Invoke-WebRequest|Invoke-RestMethod)\b|\bfetch\s*\(|https?:\/\/|\brequests\.(get|post)|urllib|axios|http\.client|net\.connect/i;

export interface SkillLintReport {
  name: string;
  issues: Issue[];
  tokens: { body: number; description: number; total: number };
  bodyLines: number;
}

/** Lint one skill folder against the lightness rules (spec 7.2). `label` is the path shown in issues. */
export function lintSkill(files: SkillFiles, label: string): SkillLintReport {
  const { skill, issues } = parseSkill(files, label);
  const file = `${label}/SKILL.md`;
  if (!skill) return { name: label.split('/').pop() ?? label, issues, tokens: { body: 0, description: 0, total: 0 }, bodyLines: 0 };
  const dirName = label.split('/').pop();
  const out = [...issues];
  const fmLines = files['SKILL.md'].split('\n').length - skill.body.split('\n').length;

  if (skill.name !== dirName) out.push(err('skill_name_mismatch', `name "${skill.name}" must equal the folder name "${dirName}"`, file, { line: 2 }));
  if (skill.bodyLines > SKILL_LIMITS.bodyLines) out.push(err('skill_body_lines', `body is ${skill.bodyLines} lines (max ${SKILL_LIMITS.bodyLines}); move material into references/`, file, { line: fmLines + SKILL_LIMITS.bodyLines }));
  if (skill.tokens.body > SKILL_LIMITS.bodyTokens) out.push(err('skill_body_tokens', `body is about ${skill.tokens.body} tokens (max ${SKILL_LIMITS.bodyTokens})`, file));
  if (skill.description.length > SKILL_LIMITS.description) out.push(err('skill_description_long', `description is ${skill.description.length} chars (max ${SKILL_LIMITS.description})`, file, { line: 3 }));
  if (!WHEN_RE.test(skill.description)) out.push(err('skill_description_when', 'description must say when to use the skill ("Use when ...")', file, { line: 3 }));
  if (skill.meta.produces.length > SKILL_LIMITS.produces) out.push(warn('skill_many_produces', `declares ${skill.meta.produces.length} produces entries (more than ${SKILL_LIMITS.produces}): one job per skill`, file));

  // large material must be loaded on demand and named in the body
  for (const r of skill.references) {
    if (!skill.body.includes(r)) out.push(err('skill_reference_unnamed', `${r} is not mentioned in the body; say when to read it`, file));
    else if (!/\b(when|only|if|before|for)\b/i.test(lineContaining(skill.body, r))) out.push(warn('skill_reference_when', `the line naming ${r} should say when to read it`, file));
    const rt = estimateTokens(files[r]);
    if (rt > 6000) out.push(warn('skill_reference_large', `${r} is about ${rt} tokens; consider splitting`, `${label}/${r}`));
  }
  for (const m of skill.body.matchAll(/references\/[\w./-]+\.md/g)) if (!(m[0] in files)) out.push(err('skill_reference_missing', `${m[0]} is named in the body but does not exist`, file));

  for (const s of skill.scripts) {
    const content = files[s];
    if (!skill.body.includes(s)) out.push(err('skill_script_undocumented', `${s} must be documented in the body`, file));
    if (/\.(sh|py|js|mjs|rb)$/.test(s) && !content.startsWith('#!')) out.push(warn('skill_script_not_executable', `${s} has no shebang line (must be executable)`, `${label}/${s}`));
    if (!skill.meta.network && NET_CALL.test(content)) out.push(err('skill_script_network', `${s} appears to make network calls; declare zerovity.network: true or remove`, `${label}/${s}`));
  }

  // hygiene across every text file in the folder
  for (const [f, c] of Object.entries(files)) {
    const fl = f === 'SKILL.md' ? file : `${label}/${f}`;
    if (redactText(c) !== c) out.push(err('skill_secret', 'looks like it contains a secret or token', fl));
    if (f.endsWith('.md')) {
      const abs = ABS_PATH.exec(c);
      if (abs) out.push(err('skill_absolute_path', `absolute path "${abs[2]}" is not portable`, fl));
      const tool = TOOL_NAMES.exec(c);
      if (tool) out.push(err('skill_tool_name', `harness-specific tool name "${tool[0]}" - describe the action instead`, fl));
    }
  }
  return { name: skill.name, issues: out, tokens: skill.tokens, bodyLines: skill.bodyLines };
}

function lineContaining(body: string, needle: string): string {
  return body.split('\n').find((l) => l.includes(needle)) ?? '';
}

/** Weight an agent adds: its body plus the always-loaded skill descriptions (spec 7.2). */
export function agentWeight(agentBody: string, skills: Array<Pick<Skill, 'name' | 'description' | 'tokens'>>): { body: number; skillDescriptions: number; total: number; onDemand: number } {
  const body = estimateTokens(agentBody);
  const skillDescriptions = skills.reduce((n, s) => n + s.tokens.description + estimateTokens(s.name) + 3, 0);
  const onDemand = skills.reduce((n, s) => n + s.tokens.body, 0);
  return { body, skillDescriptions, total: body + skillDescriptions, onDemand };
}


import { z } from 'zod';
import { createHash } from 'node:crypto';
import { estimateTokens } from '@zerovity/core';
import { parseFrontmatter, checkSchema, type Issue, err } from '@zerovity/definition';

export type SkillFiles = Record<string, string>; // relative to the skill folder: SKILL.md, references/x.md, scripts/y.sh

export const SkillMetaSchema = z
  .object({
    version: z.string().default('0.0.0'),
    phases: z.array(z.string()).default([]),
    consumes: z.array(z.string()).default([]),
    produces: z.array(z.string()).default([]),
    escalate: z.string().optional(),
    network: z.boolean().default(false),
  })
  .strict();

export const SkillFrontmatterSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    description: z.string().min(1),
    zerovity: SkillMetaSchema.optional(),
    // tolerated keys used by other tools reading the same open format
    license: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    'allowed-tools': z.unknown().optional(),
    origin: z.string().optional(),
  })
  .strict();

export interface Skill {
  name: string;
  description: string;
  meta: z.infer<typeof SkillMetaSchema>;
  body: string;
  bodyLines: number;
  files: SkillFiles;
  references: string[];
  scripts: string[];
  tokens: { body: number; description: number; total: number };
  contentHash: string;
}

export interface ParsedSkill { skill?: Skill; issues: Issue[] }

export function parseSkill(files: SkillFiles, fileLabel: string): ParsedSkill {
  const main = files['SKILL.md'];
  const file = `${fileLabel}/SKILL.md`;
  if (main === undefined) return { issues: [err('skill_missing_file', 'SKILL.md is missing', fileLabel)] };
  const fm = parseFrontmatter(main, file);
  const issues = [...fm.issues];
  if (!fm.yaml) return { issues: [...issues, err('frontmatter', 'SKILL.md needs frontmatter with name and description', file, { line: 1 })] };
  const c = checkSchema(SkillFrontmatterSchema, fm.yaml, file);
  issues.push(...c.issues);
  if (!c.value) return { issues };
  const references = Object.keys(files).filter((f) => f.startsWith('references/'));
  const scripts = Object.keys(files).filter((f) => f.startsWith('scripts/'));
  const meta = SkillMetaSchema.parse(c.value.zerovity ?? {});
  const body = fm.body;
  const tb = estimateTokens(body);
  const td = estimateTokens(c.value.description);
  const contentHash = sha(Object.keys(files).sort().map((k) => `${k}\0${files[k]}`).join('\0\0'));
  return { skill: { name: c.value.name, description: c.value.description, meta, body, bodyLines: fm.bodyLines, files, references, scripts, tokens: { body: tb, description: td, total: tb + td }, contentHash }, issues };
}

/** The line used in the run preamble skill index (spec 8.3). */
export const skillIndexLine = (s: Pick<Skill, 'name' | 'description'>): string => `- ${s.name} - ${s.description}`;


export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

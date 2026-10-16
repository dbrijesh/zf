import type { HarnessType } from '@zerovity/core';
import type { SkillFiles } from './skill';

/**
 * Where each harness reads skills from inside the run's worktree, and how instructions are delivered.
 * This is the single mapping table (spec 7.5). Verify against current docs when upgrading a CLI;
 * the version each path was verified against is recorded in packages/harness/<tool>/VERSION_NOTES.md.
 */
export const MATERIALISE_TABLE: Record<HarnessType, { skillsDir: string; instructions: 'append-system-prompt-file' | 'prompt-prefix' }> = {
  'claude-code': { skillsDir: '.claude/skills', instructions: 'append-system-prompt-file' },
  codex: { skillsDir: '.agents/skills', instructions: 'prompt-prefix' },
  copilot: { skillsDir: '.github/skills', instructions: 'prompt-prefix' },
  fake: { skillsDir: '.agents/skills', instructions: 'prompt-prefix' },
};

export interface MaterialisePlan {
  /** path relative to the worktree -> content */
  files: Record<string, string>;
  /** lines to append to .git/info/exclude so nothing is ever committed */
  excludes: string[];
}

export function materialiseSkills(harness: HarnessType, skills: Array<{ name: string; files: SkillFiles }>): MaterialisePlan {
  const { skillsDir } = MATERIALISE_TABLE[harness];
  const files: Record<string, string> = {};
  for (const s of skills) for (const [rel, content] of Object.entries(s.files)) files[`${skillsDir}/${s.name}/${rel}`] = content;
  // every harness gets the zerovity run folders excluded as well
  const excludes = [`/${skillsDir}/`, '/.zerovity/'];
  return { files, excludes: [...new Set(excludes)] };
}

export const materialisedDirs = (): string[] => [...new Set(Object.values(MATERIALISE_TABLE).map((t) => t.skillsDir))];

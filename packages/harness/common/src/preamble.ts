import type { ResolvedAgent } from './types';

export const RUN_DIR = '.zerovity/run';
export const OUT_DIR = '.zerovity/out';
export const CTX_DIR = '.zerovity/context';
export const INSTRUCTIONS_PATH = `${RUN_DIR}/INSTRUCTIONS.md`;
export const RESULT_PATH = `${OUT_DIR}/result.json`;
export const RESULT_SCHEMA_PATH = `${RUN_DIR}/result.schema.json`;
export const CONTEXT_PATH = `${CTX_DIR}/CONTEXT.md`;

export interface PreambleInput {
  agent: Pick<ResolvedAgent, 'name' | 'body' | 'outputs'> & { skills: Array<{ name: string; description: string }> };
  phase: string;
  workItemId: string;
  title: string;
}

/** The run preamble: same text for every harness (spec 8.3). */
export function buildPreamble(i: PreambleInput): string {
  const skillIndex = i.agent.skills.length ? i.agent.skills.map((s) => `- ${s.name} - ${s.description}`).join('\n') : '(none)';
  return [
    `You are ${i.agent.name}, working phase ${i.phase} of work item ${i.workItemId}: "${i.title}".`,
    `Read ${CONTEXT_PATH} before anything else.`,
    'Skills available to you are listed below with when to use each.',
    `Write your result to ${RESULT_PATH} using the schema in ${RESULT_SCHEMA_PATH}.`,
    'If you need information from a person, put questions in result.json and stop. Do not guess.',
    'Do not push, merge, or change git remotes. Commit your work on the current branch.',
    i.agent.outputs.length ? `Files you must produce in ${OUT_DIR}/: ${i.agent.outputs.join(', ')}.` : '',
    '',
    i.agent.body.trim(),
    '',
    '## Skills',
    skillIndex,
    '',
  ]
    .filter((l, idx, arr) => !(l === '' && arr[idx - 1] === ''))
    .join('\n');
}

export const REPAIR_PROMPT = `Write ${RESULT_PATH} now, following the schema in ${RESULT_SCHEMA_PATH}. If you could not finish, set status to "blocked" or "needs_input" and explain in summary. Do not do any other work.`;

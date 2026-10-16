import type { Phase } from '@zerovity/core';
import type { DispatchReason } from './machine';

export const PHASE_GOAL: Record<string, string> = {
  INTENT: 'Investigate the request. Search the code and linked material, reproduce any defect, list gaps, and produce triage.md with complexity, risk and the questions that remain.',
  SPEC: 'Write the product and technical spec with validation criteria as spec.md. Every requirement needs an acceptance criterion a reviewer can check.',
  BUILD: 'Implement the approved spec on the current branch, test first. Run the repository checks and capture evidence.',
  VERIFY: 'Independently verify the change against the spec, the tests, repository conventions and security. Recommend accept, revise or escalate.',
  SHIP: 'Prepare the handoff: final pull request description, changelog entry and evidence bundle for a person to review.',
  CUSTOM: 'Do the work described in your role.',
};

export interface PromptInput {
  phase: Phase | string;
  workItem: { shortId: string; title: string; body: string; sourceLabel?: string };
  reason: DispatchReason | 'start';
  loops: number;
  maxLoops: number;
  comments?: string[];
  findings?: Array<{ severity: string; file?: string; line?: number; text: string }>;
  lastError?: string;
  specPath?: string;
  hasPriorSession: boolean;
}

/** The phase prompt the orchestrator builds for each run (the agent role text and skills come via INSTRUCTIONS.md). */
export function buildPhasePrompt(i: PromptInput): string {
  const out: string[] = [];
  out.push(`Work item ${i.workItem.shortId}: ${i.workItem.title}`);
  if (i.workItem.sourceLabel) out.push(`Source: ${i.workItem.sourceLabel}`);
  out.push('', `Phase: ${i.phase}. ${PHASE_GOAL[i.phase] ?? PHASE_GOAL.CUSTOM}`);
  if (i.workItem.body.trim()) out.push('', 'Request:', i.workItem.body.trim());
  if (i.specPath && (i.phase === 'BUILD' || i.phase === 'VERIFY' || i.phase === 'SHIP')) out.push('', `The approved spec is at ${i.specPath}. It is the source of truth.`);

  switch (i.reason) {
    case 'resume_answers':
      out.push('', 'You were waiting for people. Their answers and any attached documents are now in .zerovity/context/CONTEXT.md under "Question and answer history". Read them and continue your work.');
      break;
    case 'changes_requested':
      out.push('', 'A reviewer requested changes.');
      if (i.comments?.length) out.push('Reviewer comments:', ...i.comments.map((c) => `- ${c}`));
      out.push('', 'Change only what the comments ask for, and say in your summary what changed.');
      break;
    case 'revision':
      out.push('', `Revision loop: ${i.loops} of ${i.maxLoops}`, 'Verification found problems. Fix exactly these findings, then re-run the repository checks:');
      for (const f of i.findings ?? []) out.push(`- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : ''}${f.text}`);
      break;
    case 'retry':
      out.push('', `The previous attempt did not finish${i.lastError ? `: ${i.lastError}` : '.'} Continue from the current state of the branch; do not start over.`);
      break;
    default:
      if (i.loops > 0 && (i.phase === 'BUILD' || i.phase === 'VERIFY')) out.push('', `Revision loop: ${i.loops} of ${i.maxLoops}` + (i.phase === 'VERIFY' ? ' (re-verify: confirm earlier findings are fixed and look for regressions)' : ''));
  }
  if (i.hasPriorSession && i.reason !== 'start' && i.reason !== 'next_phase') out.push('', '(This continues your earlier session.)');
  return out.join('\n');
}

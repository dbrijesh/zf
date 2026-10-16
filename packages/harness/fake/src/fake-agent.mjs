#!/usr/bin/env node
// Deterministic offline "agent" used by the fake harness. It follows the same contract as real
// harnesses: reads .zerovity/run/INSTRUCTIONS.md and .zerovity/context/CONTEXT.md from the
// working directory, emits normalised JSON events on stdout and writes .zerovity/out/result.json.
//
// Scenario flags can appear anywhere in the work item text or context:
//   [fake:ask]       ask one decision question (INTENT) until an answer is in context
//   [fake:context]   ask for a document (context_request) until context contains an attachment
//   [fake:revise]    VERIFY recommends revise on the first loop only
//   [fake:escalate]  VERIFY recommends escalate
//   [fake:fail]      the run exits with an error and writes no result
//   [fake:noresult]  finish without writing result.json (exercises the repair follow-up)
//   [fake:high-risk] triage risk high         [fake:migration] touch migrations/ (adds dbReview gate)
//   [fake:skip-spec] triage skipSpec = true   [fake:slow] sleep longer between events
import fs from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const read = (p) => (fs.existsSync(path.join(cwd, p)) ? fs.readFileSync(path.join(cwd, p), 'utf8') : '');
const instr = read('.zerovity/run/INSTRUCTIONS.md');
const ctx = read('.zerovity/context/CONTEXT.md');
const prompt = process.argv[2] ?? '';
const all = `${instr}\n${ctx}\n${prompt}`;
const flagsFile = path.join(cwd, '.zerovity', 'run', 'fake-flags.txt');
const known = new Set((fs.existsSync(flagsFile) ? fs.readFileSync(flagsFile, 'utf8') : '').split('\n').filter(Boolean));
for (const m of all.matchAll(/\[fake:([\w-]+)\]/g)) known.add(m[1]);
fs.mkdirSync(path.dirname(flagsFile), { recursive: true });
fs.writeFileSync(flagsFile, [...known].join('\n'));
const flag = (n) => known.has(n);

const head = /You are ([\w-]+), working phase (\w+) of work item ([\w-]+): "(.*)"/.exec(instr) ?? [];
const agent = head[1] ?? 'fake-agent';
const phase = head[2] ?? 'BUILD';
const workItem = head[3] ?? 'WI';
const title = head[4] ?? 'work item';
const loop = Number(/Revision loop: (\d+)/.exec(prompt)?.[1] ?? 0);
const resumed = !!process.env.ZF_FAKE_RESUME;
const delay = Number(process.env.ZF_FAKE_DELAY_MS ?? (flag('slow') ? 900 : 120));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');
const write = (rel, content) => {
  const p = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

const sessionId = process.env.ZF_FAKE_RESUME || `fake-${agent}-${Math.random().toString(36).slice(2, 8)}`;
emit({ kind: 'session.started', sessionId, model: 'fake-model' });
await sleep(delay);

if (flag('fail')) {
  emit({ kind: 'error', message: 'fake failure requested by [fake:fail]' });
  emit({ kind: 'session.ended', status: 'error' });
  process.exit(1);
}

emit({ kind: 'message.assistant', text: `${agent}: reading context for ${workItem}${resumed ? ' (resumed session)' : ''}` });
emit({ kind: 'tool.call', tool: 'read', input: { path: '.zerovity/context/CONTEXT.md' }, id: 't1' });
await sleep(delay);
emit({ kind: 'tool.result', id: 't1', ok: true, summary: `${ctx.length} chars` });

const answered = /\nANSWER[^\n]*:/i.test(ctx) || /Answer:/i.test(ctx);
const hasAttachment = /Attachment:|attached as context/i.test(ctx);
const result = { status: 'done', summary: '', questions: [], artifacts: [], evidence: [], findings: [], pathsTouched: [] };
const out = (name, content, type) => {
  write(`.zerovity/out/${name}`, content);
  result.artifacts.push({ path: `.zerovity/out/${name}`, type: type ?? name.replace(/\..*$/, '') });
  emit({ kind: 'file.changed', path: `.zerovity/out/${name}`, op: 'add' });
};

switch (phase) {
  case 'INTENT': {
    if (flag('ask') && !answered) {
      result.status = 'needs_input';
      result.summary = 'Triage started; one business rule is missing.';
      result.questions = [{ id: 'q1', kind: 'decision', text: `For "${title}": should the new rule apply to existing records as well?`, options: ['Yes', 'No'], why: 'The spec scope depends on it' }];
      break;
    }
    if (flag('context') && !hasAttachment) {
      result.status = 'needs_input';
      result.summary = 'I need a document to continue.';
      result.questions = [{ id: 'q1', kind: 'context_request', text: 'I need the current file layout from finance. Without it the column mapping is a guess.', why: 'Column mapping in the acceptance criteria' }];
      break;
    }
    const risk = flag('high-risk') ? 'high' : /refund|payment|payout|ledger|migrat/i.test(`${title} ${prompt}`) ? 'medium' : 'low';
    const skip = flag('skip-spec');
    out('triage.md', `# Triage for ${workItem}\n\nComplexity: M, risk: ${risk}\n\nEvidence: searched the repository for "${title}".\n\n## Gaps\nNone remaining.\n`, 'triage');
    result.summary = `Triage done: complexity M, risk ${risk}${skip ? ', spec skipped' : ''}.`;
    result.triage = { complexity: skip ? 'S' : 'M', risk, skipSpec: skip };
    result.pathsTouched = flag('migration') ? ['src/app.ts', 'migrations/0042_fake.sql'] : ['src/app.ts'];
    break;
  }
  case 'SPEC': {
    const comments = /Reviewer comments:\s*([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1]?.trim();
    out('spec.md', `# ${workItem} ${title}\nStatus: Draft\n\n## 3. Requirements\n- R1. The system must implement "${title}".\n${comments ? `- R2. Revised after review: ${comments}\n` : ''}\n## 4. Acceptance criteria\n- AC1 (R1) Given the feature is enabled, when it is used, then the expected result occurs. Check: unit test.\n`, 'spec');
    result.summary = comments ? `Spec revised for reviewer comments: ${comments}` : 'Spec written with 1 requirement and 1 acceptance criterion.';
    break;
  }
  case 'BUILD': {
    const rel = `fake-output/${workItem}.md`;
    write(rel, `# ${title}\n\nImplemented by ${agent} (fake harness).\n${loop ? `Revision ${loop} applied.\n` : ''}`);
    emit({ kind: 'file.changed', path: rel, op: 'add' });
    emit({ kind: 'tool.call', tool: 'shell', input: { command: 'npm test' }, id: 't2' });
    await sleep(delay);
    emit({ kind: 'command.run', command: 'npm test', exitCode: 0 });
    emit({ kind: 'tool.result', id: 't2', ok: true, summary: '12 passed' });
    write('.zerovity/out/validation.log', '$ npm test\n12 passed, 0 failed\n');
    out('evidence.md', `# Evidence\n\n| AC | check | result |\n|---|---|---|\n| AC1 | unit test | pass |\n`, 'evidence');
    result.evidence = [{ type: 'test_run', command: 'npm test', exitCode: 0, logPath: '.zerovity/out/validation.log' }];
    result.pathsTouched = flag('migration') ? [rel, 'migrations/0042_fake.sql'] : [rel];
    result.summary = loop ? `Fixed review findings (loop ${loop}); checks pass.` : 'Implemented AC1 test first; all repository checks pass.';
    break;
  }
  case 'VERIFY': {
    const revise = flag('revise') && loop === 0;
    const escalate = flag('escalate');
    out('review.md', `# Review of ${workItem}\n\n${revise ? 'One finding to address.' : 'No blocking findings.'}\n`, 'review');
    result.recommendation = escalate ? 'escalate' : revise ? 'revise' : 'accept';
    if (revise) result.findings = [{ severity: 'high', file: `fake-output/${workItem}.md`, line: 1, text: 'Add a boundary test for the empty input case.' }];
    result.summary = `Verification recommends ${result.recommendation}.`;
    break;
  }
  case 'SHIP': {
    out('pr-description.md', `## What and why\n${title} (${workItem})\n\n## How it was checked\nAC1: unit test, pass.\n\n## Flags\nNone\n`, 'pr_description');
    out('changelog-entry.md', `- ${title} (${workItem})\n`, 'changelog');
    result.summary = 'PR description and changelog entry written.';
    break;
  }
  default:
    result.summary = `Completed custom phase ${phase}.`;
}

emit({ kind: 'message.assistant', text: result.summary });
const inTok = 1800 + (phase.length * 211) % 900;
emit({ kind: 'usage', inputTokens: inTok, outputTokens: Math.round(inTok / 6), cachedTokens: Math.round(inTok / 3) });

if (!flag('noresult') || process.env.ZF_FAKE_REPAIR) write('.zerovity/out/result.json', JSON.stringify(result, null, 2));
emit({ kind: 'session.ended', status: 'success' });

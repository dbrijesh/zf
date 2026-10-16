import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateDefinition, loadDir, parsePolicy, evaluatePolicy, tryParsePolicy, jsonSchemaFor, parseFrontmatter, formatIssue, validCron, type Files } from '../src';

const ROOT = path.resolve(__dirname, '../../..');
const packSkills = () => ({ 'zerovity-core': fs.readdirSync(path.join(ROOT, 'packs/zerovity-core/skills')) });
const packAgents = () => ({ 'zerovity-core': fs.readdirSync(path.join(ROOT, 'packs/zerovity-core/agents')) });

const base = (extra: Files = {}): Files => ({
  'zerovity.factory.yaml': `schemaVersion: zf/v1alpha1\nname: t\nsecrets: [A_KEY]\n`,
  ...extra,
});

describe('examples validate', () => {
  for (const ex of ['01-single-repo', '02-issue-to-pr']) {
    it(ex, () => {
      const r = validateDefinition(loadDir(path.join(ROOT, 'examples', ex)), { packSkills: packSkills(), packAgents: packAgents() });
      expect(r.issues.filter((i) => i.severity === 'error').map(formatIssue)).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }
});

describe('invalid fixtures report file and line', () => {
  it('missing factory file', () => {
    const r = validateDefinition({});
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'missing_file', file: 'zerovity.factory.yaml' });
  });

  it('unknown keys are errors with the line of the key', () => {
    const r = validateDefinition(base({ 'zerovity.factory.yaml': `schemaVersion: zf/v1alpha1\nname: t\nbogus: 1\n` }));
    const i = r.issues.find((x) => x.code === 'unknown_key');
    expect(i).toMatchObject({ file: 'zerovity.factory.yaml', line: 3 });
  });

  it('yaml syntax error has a line', () => {
    const r = validateDefinition(base({ 'zerovity.factory.yaml': `schemaVersion: zf/v1alpha1\nname: [oops\n` }));
    expect(r.issues[0].code).toBe('yaml_syntax');
    expect(r.issues[0].line).toBeGreaterThan(0);
  });

  it('wrong schema version', () => {
    const r = validateDefinition(base({ 'zerovity.factory.yaml': `schemaVersion: zf/v9\nname: t\n` }));
    expect(r.issues.some((i) => i.code === 'schema' && i.line === 1)).toBe(true);
  });

  it('undeclared secret references', () => {
    const r = validateDefinition(base({ 'zerovity.factory.yaml': `schemaVersion: zf/v1alpha1\nname: t\ngateway:\n  anthropicBaseUrl: \${secret:NOPE}\n` }));
    expect(r.issues.find((i) => i.code === 'undeclared_secret')).toBeTruthy();
  });

  it('agent frontmatter errors map to the frontmatter line', () => {
    const r = validateDefinition(base({ 'agents/a/agent.md': `---\ndescription: d\nphase: NOPE\n---\nbody\n` }));
    const i = r.issues.find((x) => x.file === 'agents/a/agent.md' && x.code === 'schema');
    expect(i?.line).toBe(3);
  });

  it('agent body over 60 lines and description over 200 chars', () => {
    const body = Array.from({ length: 70 }, (_, k) => `line ${k}`).join('\n');
    const r = validateDefinition(base({ 'agents/a/agent.md': `---\ndescription: ${'x'.repeat(201)}\nphase: BUILD\n---\n${body}\n` }));
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['agent_body_long', 'agent_description_long']));
  });

  it('unresolved skills, runners, mcp servers and secrets in agents', () => {
    const r = validateDefinition(
      base({ 'agents/a/agent.md': `---\ndescription: d\nphase: BUILD\nskills: [ghost]\nrunner: nope\nmcpServers: [jira]\nsecrets: [MISSING]\n---\nbody\n` }),
    );
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['unknown_skill', 'unknown_runner', 'unknown_mcp', 'undeclared_secret']));
  });

  it('automation referencing a missing agent; bad cron', () => {
    const r = validateDefinition(
      base({ 'automations/x/automation.md': `---\nagent: ghost\ntriggers:\n  - provider: schedule\n    cron: "61 * * * *"\n---\nhi\n` }),
    );
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['unknown_agent', 'bad_cron']));
  });

  it('gates with a bad policy expression and unknown gate', () => {
    const r = validateDefinition(
      base({ 'policies/gates.yaml': `gates:\n  riskOverrides:\n    - if: triage.risk ==\n      add: [ghostGate]\n    - if: triage.risk == "high"\n      add: [ghostGate]\n` }),
    );
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['policy_syntax', 'unknown_gate']));
    expect(r.issues.find((i) => i.code === 'policy_syntax')?.line).toBe(3);
  });

  it('skill folder without SKILL.md', () => {
    const r = validateDefinition(base({ 'skills/x/notes.md': 'hi' }));
    expect(r.issues.find((i) => i.code === 'skill_missing_file')).toBeTruthy();
  });

  it('agentOverrides must name a real agent; skills from unchecked packs only warn', () => {
    const r = validateDefinition(base({ 'zerovity.factory.yaml': `schemaVersion: zf/v1alpha1\nname: t\npacks: [{name: p, version: "1.0.0"}]\nagentOverrides:\n  ghost: { runner: default }\n` }));
    expect(r.issues.some((i) => i.code === 'unknown_agent')).toBe(true);
  });

  it('merge.agentsMayMerge cannot be true', () => {
    const r = validateDefinition(base({ 'policies/gates.yaml': `merge:\n  agentsMayMerge: true\n` }));
    expect(r.ok).toBe(false);
  });

  it('a failed validation yields no definition (last valid stays in force)', () => {
    expect(validateDefinition(base({ 'zerovity.factory.yaml': 'name: x' })).definition).toBeUndefined();
  });
});

describe('policy expressions', () => {
  const ctx = { triage: { risk: 'high', complexity: 'M', skipSpec: false }, paths: { touched: ['src/a.ts', 'migrations/0001.sql'] }, n: 5 };
  it.each([
    ['triage.risk == "high"', true],
    ['triage.risk != "high"', false],
    ['paths.touched matches "migrations/**"', true],
    ['paths.touched matches "docs/**"', false],
    ['triage.complexity in ["M","L"] && !triage.skipSpec', true],
    ['triage.risk == "low" || n >= 5', true],
    ['not (n < 5) and n <= 5', true],
    ['paths.touched contains "src/a.ts"', true],
    ['missing.path == "x"', false],
    ['true', true],
  ])('%s -> %s', (expr, expected) => expect(evaluatePolicy(expr, ctx)).toBe(expected));

  it('reports columns for syntax errors', () => {
    const r = tryParsePolicy('triage.risk == ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.col).toBeGreaterThan(0);
    expect(tryParsePolicy('a $ b').ok).toBe(false);
    expect(tryParsePolicy('(a == 1').ok).toBe(false);
    expect(tryParsePolicy('"unterminated').ok).toBe(false);
  });
  it('parses to an AST', () => expect(parsePolicy('a == 1').t).toBe('bin'));
});

describe('schemas and helpers', () => {
  it('json schemas exist for every doc and are strict', () => {
    for (const d of ['factory', 'agent', 'gates', 'automation', 'runner', 'scorer', 'context', 'lock', 'pack'] as const) {
      const js = jsonSchemaFor(d);
      expect(js.$id).toContain(d);
    }
    expect((jsonSchemaFor('factory') as { additionalProperties?: unknown }).additionalProperties).toBe(false);
  });
  it('frontmatter body start line', () => {
    const fm = parseFrontmatter('---\na: 1\n---\nhello\nworld\n', 'x.md');
    expect(fm.data).toEqual({ a: 1 });
    expect(fm.bodyStartLine).toBe(4);
    expect(fm.bodyLines).toBe(2);
  });
  it('cron validation', () => {
    expect(validCron('0 3 * * 1')).toBe(true);
    expect(validCron('*/15 * * * *')).toBe(true);
    expect(validCron('0 3 * *')).toBe(false);
  });
});

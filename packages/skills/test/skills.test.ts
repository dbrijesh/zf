import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadDir } from '@zerovity/definition';
import {
  lintSkill, loadPackDir, dirPackRegistry, resolveLock, loadLocked, diffPacks, resolveAll, effectiveSkills, materialiseSkills, MATERIALISE_TABLE, satisfies, maxSatisfying,
  packToTarball, packFromTarball, validateFactory, agentWeight, MemoryPackRegistry, type SkillFiles,
} from '../src';

const ROOT = path.resolve(__dirname, '../../..');
const corePack = () => loadPackDir(path.join(ROOT, 'packs/zerovity-core'));

const skill = (over: Partial<{ name: string; desc: string; body: string; extra: string }> = {}, files: SkillFiles = {}): SkillFiles => ({
  'SKILL.md': `---\nname: ${over.name ?? 'my-skill'}\ndescription: ${over.desc ?? 'Does a thing. Use when a thing needs doing.'}\n${over.extra ?? ''}---\n\n${over.body ?? '# Title\n\n1. Do it.\n'}`,
  ...files,
});
const codes = (f: SkillFiles, label = 'skills/my-skill') => lintSkill(f, label).issues.map((i) => i.code);

describe('lint rules (spec 7.2)', () => {
  it('a clean skill passes', () => expect(lintSkill(skill(), 'skills/my-skill').issues.filter((i) => i.severity === 'error')).toEqual([]));
  it('body over 150 lines', () => expect(codes(skill({ body: Array.from({ length: 160 }, (_, i) => `line ${i}`).join('\n') }))).toContain('skill_body_lines'));
  it('body over 2000 tokens', () => expect(codes(skill({ body: ('word '.repeat(10) + '\n').repeat(60) + 'abcdefghij '.repeat(900) }))).toContain('skill_body_tokens'));
  it('description over 300 chars', () => expect(codes(skill({ desc: 'Use when ' + 'x'.repeat(320) }))).toContain('skill_description_long'));
  it('description must say when to use', () => expect(codes(skill({ desc: 'Writes things.' }))).toContain('skill_description_when'));
  it('name must equal folder', () => expect(codes(skill({ name: 'other' }))).toContain('skill_name_mismatch'));
  it('warns when more than 3 produces', () => expect(codes(skill({ extra: 'zerovity:\n  produces: [a, b, c, d]\n' }))).toContain('skill_many_produces'));
  it('references must be named in the body', () => expect(codes(skill({}, { 'references/big.md': 'x' }))).toContain('skill_reference_unnamed'));
  it('named references pass; missing references fail', () => {
    expect(codes(skill({ body: 'Read references/big.md only when the case is large.\n' }, { 'references/big.md': 'x' }))).not.toContain('skill_reference_unnamed');
    expect(codes(skill({ body: 'Read references/gone.md only when needed.\n' }))).toContain('skill_reference_missing');
  });
  it('scripts: documented, executable, no network unless declared', () => {
    const f = skill({ body: 'Run scripts/ok.sh to check.\n' }, { 'scripts/ok.sh': '#!/bin/sh\necho hi\n', 'scripts/net.sh': '#!/bin/sh\ncurl https://x.test\n', 'scripts/plain.py': 'print(1)\n' });
    const c = codes(f);
    expect(c).toContain('skill_script_undocumented'); // net.sh and plain.py
    expect(c).toContain('skill_script_network');
    expect(c).toContain('skill_script_not_executable');
    const ok = skill({ body: 'Run scripts/net.sh to fetch.\n', extra: 'zerovity:\n  network: true\n' }, { 'scripts/net.sh': '#!/bin/sh\ncurl https://x.test\n' });
    expect(codes(ok)).not.toContain('skill_script_network');
  });
  it('no secrets', () => expect(codes(skill({ body: 'Use key sk-ant-api03-abcdefghijklmnop1234 here.\n' }))).toContain('skill_secret'));
  it('no absolute paths', () => {
    expect(codes(skill({ body: 'Edit /home/bob/project/a.ts\n' }))).toContain('skill_absolute_path');
    expect(codes(skill({ body: 'Edit C:\\Users\\bob\\a.ts\n' }))).toContain('skill_absolute_path');
    expect(codes(skill({ body: 'Edit src/a.ts and docs/adr/0001.md\n' }))).not.toContain('skill_absolute_path');
  });
  it('no harness-specific tool names', () => {
    expect(codes(skill({ body: 'Call the AskUserQuestion tool\n' }))).toContain('skill_tool_name');
    expect(codes(skill({ body: 'Use Bash(git *) to commit\n' }))).toContain('skill_tool_name');
  });
  it('missing frontmatter or SKILL.md', () => {
    expect(codes({ 'README.md': 'x' })).toContain('skill_missing_file');
    expect(codes({ 'SKILL.md': 'no frontmatter' })).toContain('frontmatter');
  });
  it('unknown frontmatter keys are errors', () => expect(codes(skill({ extra: 'bogus: 1\n' }))).toContain('unknown_key'));
});

describe('zerovity-core pack', () => {
  const pack = corePack();
  it('has 14 skills and 5 agents', () => {
    expect(Object.keys(pack.skills)).toHaveLength(14);
    expect(Object.keys(pack.agents)).toHaveLength(5);
  });
  for (const [name, files] of Object.entries(corePack().skills)) {
    it(`skill ${name} passes lint with no errors or warnings`, () => {
      const r = lintSkill(files, `skills/${name}`);
      expect(r.issues.map((i) => `${i.code}: ${i.message}`)).toEqual([]);
      expect(r.bodyLines).toBeLessThanOrEqual(150);
      expect(r.tokens.body).toBeLessThanOrEqual(2000);
    });
  }
  it('agent weight is reported and light', () => {
    const eff = effectiveSkills('zerovity-executor', pack.agents['zerovity-executor'], ['zerovity-tdd-loop', 'zerovity-repo-validation'], { packs: [pack], factory: {}, agent: {} });
    expect(eff.skills.map((s) => s.name)).toEqual(['zerovity-tdd-loop', 'zerovity-repo-validation']);
    expect(eff.weight.total).toBeLessThan(900);
    expect(eff.weight.onDemand).toBeGreaterThan(eff.weight.skillDescriptions);
  });
});

describe('resolution precedence (spec 7.3)', () => {
  const pack = corePack();
  const mk = (n: string, d: string) => skill({ name: n, desc: d });
  it('pack < factory < agent; later wins and records overrides', () => {
    const src = {
      packs: [pack],
      factory: { 'zerovity-tdd-loop': mk('zerovity-tdd-loop', 'Factory version. Use when building.') },
      agent: { 'zerovity-executor': { 'zerovity-tdd-loop': mk('zerovity-tdd-loop', 'Agent version. Use when building.') } },
    };
    expect(resolveAll('zerovity-executor', src).get('zerovity-tdd-loop')).toMatchObject({ layer: 'agent', description: 'Agent version. Use when building.', overrides: ['pack', 'factory'] });
    expect(resolveAll('zerovity-verifier', src).get('zerovity-tdd-loop')).toMatchObject({ layer: 'factory' });
    expect(resolveAll('zerovity-verifier', { ...src, factory: {} }).get('zerovity-tdd-loop')).toMatchObject({ layer: 'pack', source: 'zerovity-core' });
  });
  it('later packs override earlier packs; agent-private skills load automatically; unresolved are reported', () => {
    const a = { ...pack, manifest: { ...pack.manifest, name: 'a' }, skills: { s1: mk('s1', 'A. Use when a.') } };
    const b = { ...pack, manifest: { ...pack.manifest, name: 'b' }, skills: { s1: mk('s1', 'B. Use when b.') } };
    const r = effectiveSkills('x', 'body', ['s1', 'ghost'], { packs: [a, b], factory: {}, agent: { x: { priv: mk('priv', 'Private. Use when private.') } } });
    expect(r.skills.find((s) => s.name === 's1')?.source).toBe('b');
    expect(r.skills.map((s) => s.name)).toContain('priv');
    expect(r.missing).toEqual(['ghost']);
  });
});

describe('materialisation', () => {
  it('writes under each harness skill path and excludes them from git', () => {
    for (const h of ['claude-code', 'codex', 'copilot'] as const) {
      const plan = materialiseSkills(h, [{ name: 's', files: { 'SKILL.md': 'x', 'references/r.md': 'y' } }]);
      const dir = MATERIALISE_TABLE[h].skillsDir;
      expect(Object.keys(plan.files).sort()).toEqual([`${dir}/s/SKILL.md`, `${dir}/s/references/r.md`]);
      expect(plan.excludes).toContain(`/${dir}/`);
      expect(plan.excludes).toContain('/.zerovity/');
    }
    expect(MATERIALISE_TABLE['claude-code'].skillsDir).toBe('.claude/skills');
  });
});

describe('packs, lock and registry', () => {
  it('semver ranges', () => {
    expect(satisfies('1.2.3', '^1.0.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfies('0.2.5', '^0.2.1')).toBe(true);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfies('1.5.0', '>=1.2.0 <2.0.0')).toBe(true);
    expect(satisfies('1.5.0', '*')).toBe(true);
    expect(satisfies('1.x'.replace('x', '4') + '.0', '1.x')).toBe(true);
    expect(maxSatisfying(['1.0.0', '1.4.0', '2.0.0'], '^1.0.0')).toBe('1.4.0');
  });
  it('lock pins version and content hash and detects tampering', async () => {
    const reg = dirPackRegistry(path.join(ROOT, 'packs'));
    const { lock } = await resolveLock([{ name: 'zerovity-core', version: '^1.0.0' }], reg);
    expect(lock.packs[0]).toMatchObject({ name: 'zerovity-core', version: '1.0.0' });
    expect((await loadLocked(lock, reg)).problems).toEqual([]);
    const tampered = { ...lock, packs: [{ ...lock.packs[0], hash: 'sha256:bad' }] };
    expect((await loadLocked(tampered, reg)).problems[0]).toMatch(/content hash differs/);
  });
  it('tarball round trip preserves the pack hash', async () => {
    const p = corePack();
    const back = await packFromTarball(await packToTarball(p));
    expect(back.hash).toBe(p.hash);
  });
  it('upgrade diff lists added, removed and changed skills', () => {
    const p = corePack();
    const v2 = { ...p, manifest: { ...p.manifest, version: '1.1.0' }, skills: { ...p.skills, 'new-skill': skill({ name: 'new-skill' }) } as Record<string, SkillFiles> };
    delete (v2.skills as Record<string, unknown>)['zerovity-repro'];
    v2.skills['zerovity-adr-lite'] = { ...v2.skills['zerovity-adr-lite'], 'SKILL.md': v2.skills['zerovity-adr-lite']['SKILL.md'] + '\nx' };
    expect(diffPacks(p, v2)).toMatchObject({ added: ['new-skill'], removed: ['zerovity-repro'], changed: ['zerovity-adr-lite'] });
  });
  it('registry resolves highest satisfying version', async () => {
    const p = corePack();
    const reg = new MemoryPackRegistry().add(p).add({ ...p, manifest: { ...p.manifest, version: '1.2.0' } }).add({ ...p, manifest: { ...p.manifest, version: '2.0.0' } });
    expect((await reg.resolve('zerovity-core', '^1.0.0'))?.manifest.version).toBe('1.2.0');
  });
});

describe('validateFactory (definition + lint + packs)', () => {
  const reg = dirPackRegistry(path.join(ROOT, 'packs'));
  it('example factories pass with the core pack installed', async () => {
    for (const ex of ['01-single-repo', '02-issue-to-pr']) {
      const r = await validateFactory(loadDir(path.join(ROOT, 'examples', ex)), reg);
      expect(r.issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
      expect(Object.keys(r.agentSkills)).toContain('zerovity-executor');
    }
  });
  it('catches a heavy factory skill and an unknown pack', async () => {
    const files = loadDir(path.join(ROOT, 'examples/01-single-repo'));
    files['skills/heavy/SKILL.md'] = `---\nname: heavy\ndescription: Heavy.\n---\n${'x\n'.repeat(200)}`;
    files['zerovity.factory.yaml'] = files['zerovity.factory.yaml'].replace('zerovity-core', 'nope-pack');
    const r = await validateFactory(files, reg);
    const c = r.issues.map((i) => i.code);
    expect(c).toContain('skill_body_lines');
    expect(c).toContain('skill_description_when');
    expect(c).toContain('pack_not_found');
  });
  it('agent weight helper', () => {
    expect(agentWeight('word '.repeat(100), []).total).toBeGreaterThan(0);
  });
});

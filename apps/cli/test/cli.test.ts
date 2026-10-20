import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const zf = (args: string[], cwd = ROOT) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'apps/cli/bin/zf.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe('zf validate', () => {
  it('accepts the examples and prints agent weights', () => {
    const r = zf(['validate', 'examples/02-issue-to-pr', '--weights']);
    expect(r.out).toContain('Valid.');
    expect(r.out).toMatch(/zerovity-executor\s+4/);
    expect(r.code).toBe(0);
  });
  it('reports file and line for errors and exits 1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-cli-'));
    fs.writeFileSync(path.join(dir, 'zerovity.factory.yaml'), 'schemaVersion: zf/v1alpha1\nname: t\nbogus: true\n');
    const r = zf(['validate', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/zerovity\.factory\.yaml:3/);
    expect(r.out).toContain('Unknown key "bogus"');
  });
  it('json mode is parseable', () => {
    const r = zf(['validate', 'examples/01-single-repo', '--json']);
    const json = JSON.parse(r.out.slice(r.out.indexOf('[')));
    expect(Array.isArray(json)).toBe(true);
  });
});

describe('zf skills lint and schema', () => {
  it('lints the core pack clean', () => {
    const r = zf(['skills', 'lint', 'packs/zerovity-core', '--strict']);
    expect(r.out).toContain('14 skills, 0 errors, 0 warnings');
    expect(r.code).toBe(0);
  });
  it('fails a heavy skill', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-sk-'));
    fs.mkdirSync(path.join(dir, 'heavy'));
    fs.writeFileSync(path.join(dir, 'heavy', 'SKILL.md'), `---\nname: heavy\ndescription: Heavy.\n---\n${'line\n'.repeat(200)}`);
    const r = zf(['skills', 'lint', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('skill_body_lines');
  });
  it('prints JSON Schemas', () => {
    expect(JSON.parse(zf(['schema', 'agent']).out).$id).toContain('agent');
    expect(zf(['schema', 'nope']).code).toBe(1);
  });
});

describe('zf pack', () => {
  it('installs only the chosen skills into a definition and locks the pack', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pack-'));
    fs.writeFileSync(path.join(dir, 'zerovity.factory.yaml'), 'schemaVersion: zf/v1alpha1\nname: t\n');
    const r = zf(['pack', 'install', 'zerovity-core', '--dir', dir, '--skills', 'zerovity-tdd-loop,zerovity-repo-validation']);
    expect(r.code).toBe(0);
    const y = fs.readFileSync(path.join(dir, 'zerovity.factory.yaml'), 'utf8');
    expect(y).toContain('include:');
    expect(y).toContain('zerovity-tdd-loop');
    expect(fs.readFileSync(path.join(dir, 'zerovity.lock'), 'utf8')).toMatch(/hash: sha256:/);
    // the executor agent lists four skills but only two are installed: validation names the rest
    const v = zf(['validate', dir]);
    expect(v.out).not.toContain('zerovity-security-scan');
  });
  it('bundles a pack tarball', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zf-tgz-')), 'core.tgz');
    expect(zf(['pack', 'bundle', 'packs/zerovity-core', '-o', out]).code).toBe(0);
    expect(fs.statSync(out).size).toBeGreaterThan(5000);
  });
});

describe('zf run (offline harness)', () => {
  it('runs an agent in a throwaway copy and validates the result contract', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-repo-'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    const r = zf(['run', '--agent', 'zerovity-researcher', '--harness', 'fake', '--repo', repo, '--prompt', 'Investigate a health endpoint']);
    expect(r.out).toContain('result: done');
    expect(r.out).toContain('usage: in');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(repo, '.zerovity'))).toBe(false); // the original is untouched
  });
  it('a failing agent exits non-zero with the reason', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-repo-'));
    const r = zf(['run', '--agent', 'zerovity-researcher', '--harness', 'fake', '--repo', repo, '--prompt', 'x [fake:fail]']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no_result');
  });
  it('an unknown agent is a clear error', () => {
    expect(zf(['run', '--agent', 'ghost', '--harness', 'fake']).out).toContain('not found');
  });
});

describe('zf run with the Cursor harness (stand-in binary)', () => {
  const FAKE = path.join(ROOT, 'packages/harness/cursor/fixtures/fake-agent.mjs');
  const run = (extra: string[] = [], env: Record<string, string> = {}) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-cur-'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'apps/cli/bin/zf.mjs'), 'run', '--agent', 'zerovity-researcher', '--harness', 'cursor', '--repo', repo, '--prompt', 'Investigate a health endpoint', ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NO_COLOR: '1', ZF_CURSOR_BIN: process.execPath, ZF_CURSOR_ARGS: JSON.stringify([FAKE]), CURSOR_API_KEY: 'cur-test-key', ...env } });
    const out = `${r.stdout}${r.stderr}`;
    const work = /workdir (.+)/.exec(out)?.[1]?.trim();
    return { out, code: r.status, work };
  };
  it('detects the binary, runs headless with force and trust, parses the stream and checks the result contract', () => {
    const r = run();
    expect(r.out).toContain('harness cursor');
    expect(r.out).toContain('result: done');
    expect(r.out).toContain('Triage written by the fake Cursor agent.');
    expect(r.out).toContain('session fake-cursor-session-1');
    expect(r.out).toMatch(/usage: in \d+ . out \d+/);
    expect(r.code).toBe(0);
    const called = JSON.parse(fs.readFileSync(path.join(r.work!, '.zerovity/out/argv.json'), 'utf8'));
    expect(called.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--force', '--trust']));
    expect(called.key).toBe('cur-test-key'); // the API key reached the process, through the environment
    expect(called.args.join(' ')).not.toContain('cur-test-key'); // and never the command line
    expect(called.hasCliConfig).toBe(true); // deny rules were in place before the agent started
  });
  it('says clearly when the Cursor CLI is not installed', () => {
    const r = run([], { ZF_CURSOR_BIN: 'definitely-not-installed-cursor', ZF_CURSOR_ARGS: '' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('cursor is not installed');
  });
});
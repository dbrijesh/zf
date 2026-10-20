import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay, recoverOverlay } from '../src/overlay';
import { gitAvailable, git, prepareWorkspace, authEnv, agentGitEnv, FACTORY_EMAIL } from '../src/git';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zf-ov-'));

describe('overlay: run files never outlive the run', () => {
  it('removes what it created, including new folders, and restores files that already existed', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'mine', 'SKILL.md'), 'the repo owns this');
    const ov = new Overlay(root);
    ov.write('.claude/skills/mine/SKILL.md', 'factory version');
    ov.write('.claude/skills/other/SKILL.md', 'new');
    ov.write('.cursor/mcp.json', '{"token":"secret"}');
    expect(fs.readFileSync(path.join(root, '.cursor', 'mcp.json'), 'utf8')).toContain('secret');
    ov.restore();
    expect(fs.readFileSync(path.join(root, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('the repo owns this');
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'other'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.cursor'))).toBe(false);
    ov.restore(); // idempotent
  });

  it('keeps the first original when a path is written twice (follow-up commands rewrite config)', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'cfg.json'), 'orig');
    const ov = new Overlay(root);
    ov.write('cfg.json', 'a'); ov.write('cfg.json', 'b');
    ov.restore();
    expect(fs.readFileSync(path.join(root, 'cfg.json'), 'utf8')).toBe('orig');
  });

  it('refuses to write outside the workspace', () => {
    expect(() => new Overlay(tmp()).write('../escape.txt', 'x')).toThrow(/outside the workspace/);
  });

  it('a crashed run is cleaned up from the journal by the next run', () => {
    const root = tmp(); const journal = path.join(root, '.zerovity', 'run', 'overlay.json');
    fs.writeFileSync(path.join(root, 'tracked.json'), 'orig');
    const ov = new Overlay(root, journal);
    ov.write('tracked.json', 'factory'); ov.write('.cursor/mcp.json', 'secret');
    // simulate a crash: no restore(), a new process starts
    expect(recoverOverlay(journal)).toBe(2);
    expect(fs.readFileSync(path.join(root, 'tracked.json'), 'utf8')).toBe('orig');
    expect(fs.existsSync(path.join(root, '.cursor'))).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
    expect(recoverOverlay(journal)).toBe(0);
  });
});

describe('git credentials never reach the working copy', () => {
  it('builds a header scoped to the remote origin only', () => {
    const env = authEnv('https://github.com/a/b.git', { token: 'ghs_secret' });
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString()).toBe('x-access-token:ghs_secret');
    expect(authEnv('https://github.com/a/b.git')).toEqual({});
  });

  it('the agent gets the factory identity and none of the operator git config', () => {
    const e = agentGitEnv('/x/agent.gitconfig');
    expect(e).toMatchObject({ GIT_AUTHOR_EMAIL: FACTORY_EMAIL, GIT_COMMITTER_EMAIL: FACTORY_EMAIL, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/x/agent.gitconfig', GIT_TERMINAL_PROMPT: '0' });
  });

  it.skipIf(!gitAvailable())('a clone with a token stores a clean URL, and an old token-bearing remote is scrubbed', async () => {
    const dir = tmp();
    const bare = path.join(dir, 'remote.git'); fs.mkdirSync(bare);
    await git(bare, ['init', '--bare', '-b', 'main']);
    const seed = path.join(dir, 'seed'); fs.mkdirSync(seed);
    await git(seed, ['init', '-b', 'main']); fs.writeFileSync(path.join(seed, 'a.txt'), '1'); await git(seed, ['add', '-A']); await git(seed, ['commit', '-m', 'init']); await git(seed, ['push', bare, 'main']);
    const url = `file:///${bare.replace(/\\/g, '/').replace(/^\//, '')}`;
    const ws = await prepareWorkspace({ dir: path.join(dir, 'work'), branch: 'zerovity/zf-1-x', defaultBranch: 'main', cloneUrl: url, auth: { token: 'ghs_SECRET_TOKEN' }, exclude: [] });
    expect(fs.readFileSync(path.join(ws.dir, '.git', 'config'), 'utf8')).not.toContain('ghs_SECRET_TOKEN');
    // a clone made by an older version had the token in its remote: the next run rewrites it
    await git(ws.dir, ['remote', 'set-url', 'origin', url.replace('file:///', 'file://x-access-token:ghs_OLD@/')], { allowFail: true });
    await prepareWorkspace({ dir: ws.dir, branch: 'zerovity/zf-1-x', defaultBranch: 'main', cloneUrl: url, auth: { token: 'ghs_SECRET_TOKEN' }, exclude: [] });
    expect(fs.readFileSync(path.join(ws.dir, '.git', 'config'), 'utf8')).not.toContain('ghs_OLD');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
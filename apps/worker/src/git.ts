import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from '@zerovity/core';

export interface GitResult { code: number; stdout: string; stderr: string }

export function gitAvailable(): boolean {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** Remove credentials from anything we might log. */
const scrub = (s: string) => redactText(s).replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@');

export function git(cwd: string, args: string[], o: { env?: Record<string, string>; allowFail?: boolean; input?: string } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Zerovity Factory', GIT_AUTHOR_EMAIL: 'factory@zerovity.local', GIT_COMMITTER_NAME: 'Zerovity Factory', GIT_COMMITTER_EMAIL: 'factory@zerovity.local', ...o.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => {
      const r = { code: code ?? 1, stdout, stderr };
      if (r.code !== 0 && !o.allowFail) reject(new Error(`git ${args[0]} failed (${r.code}): ${scrub(stderr || stdout).slice(0, 600)}`));
      else resolve(r);
    });
    if (o.input) p.stdin.end(o.input); else p.stdin.end();
  });
}

export interface WorkspaceInfo { dir: string; branch: string; baseSha?: string; hasRemote: boolean; usedGit: boolean; created: boolean }

/**
 * Prepare the working copy for a work item: a normal clone on the work item's branch (self-contained .git so the
 * same folder works on the host and inside a container, and the agent's session keeps a stable cwd across runs).
 * Without a clone URL (demo / LocalForge) a fresh local repository is created; without git a plain folder is used.
 */
export async function prepareWorkspace(o: { dir: string; branch: string; defaultBranch: string; cloneUrl?: string; exclude: string[] }): Promise<WorkspaceInfo> {
  const usedGit = gitAvailable();
  const exists = fs.existsSync(path.join(o.dir, '.git'));
  fs.mkdirSync(o.dir, { recursive: true });
  if (!usedGit) return { dir: o.dir, branch: o.branch, hasRemote: false, usedGit: false, created: !exists };
  let created = false;
  if (!exists) {
    created = true;
    if (o.cloneUrl) {
      fs.rmSync(o.dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(o.dir), { recursive: true });
      await git(path.dirname(o.dir), ['clone', '--no-tags', o.cloneUrl, path.basename(o.dir)]);
    } else {
      await git(o.dir, ['init', '-b', o.defaultBranch]);
      fs.writeFileSync(path.join(o.dir, 'README.md'), '# Demo repository\n\nCreated by Zerovity Factory because no repository connection exists yet.\n');
      await git(o.dir, ['add', '-A']);
      await git(o.dir, ['commit', '-m', 'Initial commit']);
    }
  } else if (o.cloneUrl) {
    await git(o.dir, ['remote', 'set-url', 'origin', o.cloneUrl], { allowFail: true });
    await git(o.dir, ['fetch', '--no-tags', 'origin'], { allowFail: true });
  }
  const hasRemote = (await git(o.dir, ['remote'], { allowFail: true })).stdout.trim().length > 0;
  // branch: reuse if present locally or on the remote, otherwise create from the default branch
  const local = (await git(o.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`], { allowFail: true })).code === 0;
  if (local) await git(o.dir, ['checkout', o.branch]);
  else {
    const remote = hasRemote && (await git(o.dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${o.branch}`], { allowFail: true })).code === 0;
    if (remote) await git(o.dir, ['checkout', '-b', o.branch, `origin/${o.branch}`]);
    else {
      const base = hasRemote ? `origin/${o.defaultBranch}` : o.defaultBranch;
      await git(o.dir, ['checkout', '-b', o.branch, base], { allowFail: false });
    }
  }
  // never commit factory files
  const ex = path.join(o.dir, '.git', 'info', 'exclude');
  const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  const add = o.exclude.filter((l) => !cur.split('\n').includes(l));
  if (add.length) fs.appendFileSync(ex, (cur.endsWith('\n') || !cur ? '' : '\n') + add.join('\n') + '\n');
  const baseSha = (await git(o.dir, ['rev-parse', 'HEAD'], { allowFail: true })).stdout.trim() || undefined;
  return { dir: o.dir, branch: o.branch, baseSha, hasRemote, usedGit: true, created };
}

/** Commit everything the agent left uncommitted, prefixed [zerovity:<agent>] (spec 10.4). */
export async function commitAll(dir: string, message: string): Promise<{ committed: boolean; sha?: string }> {
  await git(dir, ['add', '-A']);
  const st = await git(dir, ['status', '--porcelain']);
  if (!st.stdout.trim()) return { committed: false, sha: (await git(dir, ['rev-parse', 'HEAD'], { allowFail: true })).stdout.trim() || undefined };
  await git(dir, ['commit', '-m', message, '--no-verify']);
  return { committed: true, sha: (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim() };
}

export async function pushBranch(dir: string, branch: string, pushUrl?: string): Promise<boolean> {
  const hasRemote = (await git(dir, ['remote'], { allowFail: true })).stdout.trim().length > 0;
  if (!hasRemote && !pushUrl) return false;
  // Lease against what the remote has right now. A bare --force-with-lease needs a remote-tracking ref, which a push to a
  // token URL does not have, and then always fails with "stale info". Someone else's later push still makes this fail.
  const target = pushUrl ?? 'origin';
  const remote = (await git(dir, ['ls-remote', target, `refs/heads/${branch}`], { allowFail: true })).stdout.trim().split(/\s+/)[0] ?? '';
  await git(dir, ['push', target, `${branch}:refs/heads/${branch}`, `--force-with-lease=refs/heads/${branch}:${remote}`], { allowFail: false });
  return true;
}

export async function diffAgainst(dir: string, base: string): Promise<string> {
  const r = await git(dir, ['diff', '--no-color', `${base}...HEAD`], { allowFail: true });
  return r.stdout;
}

export async function changedFiles(dir: string, base: string): Promise<string[]> {
  const r = await git(dir, ['diff', '--name-only', `${base}...HEAD`], { allowFail: true });
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Commits on the branch by anyone other than the factory identity (autonomy rate input). */
export async function humanCommits(dir: string, base: string): Promise<number> {
  const r = await git(dir, ['log', '--format=%ae', `${base}..HEAD`], { allowFail: true });
  return r.stdout.split('\n').filter((e) => e.trim() && e.trim() !== 'factory@zerovity.local').length;
}

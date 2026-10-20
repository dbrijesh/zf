import { describe, it, expect } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostAllowed, startEgressProxy, LocalSandbox, baseEnv } from '../src/sandbox';
import { gitAvailable, prepareWorkspace, commitAll, diffAgainst, changedFiles, humanCommits, git, pushBranch } from '../src/git';

describe('egress allowlist', () => {
  it('matches exact hosts and subdomains only', () => {
    const allow = ['github.com', 'api.anthropic.com'];
    expect(hostAllowed('github.com', allow)).toBe(true);
    expect(hostAllowed('raw.github.com', allow)).toBe(true);
    expect(hostAllowed('evilgithub.com', allow)).toBe(false);
    expect(hostAllowed('github.com.evil.io', allow)).toBe(false);
    expect(hostAllowed('API.ANTHROPIC.COM.', allow)).toBe(true);
  });

  it('the proxy forwards allowed hosts and blocks the rest', async () => {
    const upstream = http.createServer((_q, r) => r.end('hello from upstream')).listen(0, '127.0.0.1');
    await new Promise((r) => upstream.once('listening', r));
    const up = (upstream.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy(() => ['127.0.0.1'], 0, '127.0.0.1');
    const viaProxy = (host: string) => new Promise<{ status: number; body: string }>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: `http://${host}:${up}/x`, headers: { host: `${host}:${up}` } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, body: b })); });
      req.end();
    });
    expect(await viaProxy('127.0.0.1')).toEqual({ status: 200, body: 'hello from upstream' });
    const blocked = await viaProxy('localhost');
    expect(blocked.status).toBe(403);
    expect(proxy.denied).toContain('localhost');
    // CONNECT to a host outside the list is refused
    const status = await new Promise<string>((resolve) => { const s = net.connect(proxy.port, '127.0.0.1', () => s.write('CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n')); s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); s.destroy(); }); });
    expect(status).toContain('403');
    await proxy.close();
    upstream.close();
  });
});

describe('local sandbox', () => {
  it('passes only an allowlisted environment to the agent process', async () => {
    process.env.ZF_MASTER_KEY = 'super-secret-master';
    process.env.DATABASE_URL = 'postgres://user:pw@db/x';
    expect(Object.keys(baseEnv())).not.toContain('ZF_MASTER_KEY');
    expect(Object.keys(baseEnv())).not.toContain('DATABASE_URL');
    const lines: string[] = [];
    const sb = new LocalSandbox(os.tmpdir());
    const r = await sb.exec(process.execPath, ['-e', 'console.log(JSON.stringify({m: process.env.ZF_MASTER_KEY ?? null, d: process.env.DATABASE_URL ?? null, x: process.env.PASSED}))'], { cwd: os.tmpdir(), env: { PASSED: 'yes' }, timeoutMs: 20_000, idleMs: 20_000, isCancelled: () => false, onLine: (l, s) => s === 'stdout' && lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(lines[0])).toEqual({ m: null, d: null, x: 'yes' });
  });

  it('kills a process that exceeds its time, goes idle, or is cancelled', async () => {
    const sb = new LocalSandbox(os.tmpdir());
    const base = { cwd: os.tmpdir(), env: {}, onLine: () => undefined };
    const sleepy = ['-e', 'setTimeout(()=>{}, 60000)'];
    expect((await sb.exec(process.execPath, sleepy, { ...base, timeoutMs: 600, idleMs: 60_000, isCancelled: () => false })).timedOut).toBe(true);
    expect((await sb.exec(process.execPath, sleepy, { ...base, timeoutMs: 60_000, idleMs: 1200, isCancelled: () => false })).idle).toBe(true);
    let cancel = false;
    setTimeout(() => (cancel = true), 300);
    expect((await sb.exec(process.execPath, sleepy, { ...base, timeoutMs: 60_000, idleMs: 60_000, isCancelled: () => cancel })).cancelled).toBe(true);
  }, 30_000);
});

describe.skipIf(!gitAvailable())('git workspace (needs git installed)', () => {
  it('creates a repo and branch, commits with the factory identity, diffs against base, excludes factory files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-git-'));
    const ws = await prepareWorkspace({ dir: path.join(dir, 'work'), branch: 'zerovity/zf-1-test', defaultBranch: 'main', exclude: ['/.zerovity/'] });
    expect(ws.usedGit).toBe(true);
    fs.mkdirSync(path.join(ws.dir, '.zerovity'), { recursive: true });
    fs.writeFileSync(path.join(ws.dir, '.zerovity', 'secret.txt'), 'x');
    fs.writeFileSync(path.join(ws.dir, 'a.txt'), 'hello');
    const c = await commitAll(ws.dir, '[zerovity:zerovity-executor] BUILD: add a');
    expect(c.committed).toBe(true);
    expect(await changedFiles(ws.dir, ws.baseSha!)).toEqual(['a.txt']);
    expect(await diffAgainst(ws.dir, ws.baseSha!)).toContain('+hello');
    expect(await humanCommits(ws.dir, ws.baseSha!)).toBe(0);
    await git(ws.dir, ['commit', '--allow-empty', '-m', 'human'], { env: { GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'bob@example.com', GIT_COMMITTER_NAME: 'Bob', GIT_COMMITTER_EMAIL: 'bob@example.com' } });
    expect(await humanCommits(ws.dir, ws.baseSha!)).toBe(1);
    expect((await commitAll(ws.dir, 'nothing')).committed).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pushes to a URL remote (no tracking ref) the first time and again after more commits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-push-'));
    const bare = path.join(dir, 'remote.git');
    fs.mkdirSync(bare);
    await git(bare, ['init', '--bare', '-b', 'main']);
    const ws = await prepareWorkspace({ dir: path.join(dir, 'work'), branch: 'zerovity/zf-2-x', defaultBranch: 'main', exclude: [] });
    fs.writeFileSync(path.join(ws.dir, 'a.txt'), '1');
    await commitAll(ws.dir, 'one');
    expect(await pushBranch(ws.dir, 'zerovity/zf-2-x', { url: bare })).toBe(true);
    fs.writeFileSync(path.join(ws.dir, 'a.txt'), '2');
    await commitAll(ws.dir, 'two');
    expect(await pushBranch(ws.dir, 'zerovity/zf-2-x', { url: bare })).toBe(true);
    const head = (await git(bare, ['rev-parse', 'refs/heads/zerovity/zf-2-x'])).stdout.trim();
    expect(head).toBe((await git(ws.dir, ['rev-parse', 'HEAD'])).stdout.trim());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

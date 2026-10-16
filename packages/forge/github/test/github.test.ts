import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { GitHubApp, appJwt, verifyWebhookSignature, parseWebhook, matchMention, matchLabel, INSTALLATION_PERMISSIONS } from '../src';
import { LocalForge } from '@zerovity/forge-common';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

function mockFetch(routes: Array<[RegExp, (url: string, init: RequestInit) => unknown]>) {
  const calls: Array<{ method: string; url: string; body?: unknown; auth?: string }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), url, body, auth: (init.headers as Record<string, string>)?.authorization });
    for (const [re, h] of routes) if (re.test(`${init.method} ${url}`)) { const r = h(url, init); return new Response(JSON.stringify(r), { status: (r as { __status?: number })?.__status ?? 200 }); }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('GitHub App auth', () => {
  it('signs a verifiable RS256 app JWT valid for under 10 minutes', () => {
    const jwt = appJwt({ appId: '123', privateKey }, 1_000_000);
    const [h, b, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
    expect(claims.iss).toBe('123');
    expect(claims.exp - claims.iat).toBeLessThan(600);
    expect(crypto.createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('requests installation tokens without merge-capable permissions and caches them', async () => {
    const { f, calls } = mockFetch([[/POST .*access_tokens/, () => ({ token: 'ghs_tok1', expires_at: new Date(Date.now() + 3600_000).toISOString() })]]);
    const app = new GitHubApp({ appId: '1', privateKey, fetchImpl: f });
    expect(await app.installationToken(99)).toBe('ghs_tok1');
    expect(await app.installationToken(99)).toBe('ghs_tok1');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ permissions: INSTALLATION_PERMISSIONS });
    expect(Object.keys(INSTALLATION_PERMISSIONS)).not.toContain('administration');
    expect(calls[0].auth).toMatch(/^Bearer /);
  });
});

describe('GitHubForge', () => {
  const setup = (routes: Parameters<typeof mockFetch>[0]) => {
    const m = mockFetch([[/POST .*access_tokens/, () => ({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() })], ...routes]);
    return { ...m, forge: new GitHubApp({ appId: '1', privateKey, fetchImpl: m.f }).forge(7) };
  };
  it('opens a draft PR and reuses an existing one on 422', async () => {
    const pr = { number: 5, html_url: 'https://github.com/a/b/pull/5', state: 'open', draft: true, head: { ref: 'zerovity/zf-1', sha: 's' }, base: { ref: 'main' }, title: 't' };
    const { forge, calls } = setup([[/POST .*\/pulls$/, () => ({ __status: 422 })], [/GET .*\/pulls\?head=/, () => [pr]]]);
    const r = await forge.openPullRequest({ owner: 'a', name: 'b', head: 'zerovity/zf-1', base: 'main', title: 't', body: 'b', draft: true });
    expect(r).toMatchObject({ number: 5, draft: true, state: 'open' });
    expect(calls.find((c) => c.method === 'POST' && /pulls$/.test(c.url))?.body).toMatchObject({ draft: true });
  });
  it('marks a PR ready via GraphQL and comments on issues', async () => {
    const pr = { number: 5, html_url: 'u', state: 'open', draft: true, node_id: 'PR_1', head: { ref: 'h', sha: 's' }, base: { ref: 'main' }, title: 't' };
    const { forge, calls } = setup([[/GET .*\/pulls\/5$/, () => pr], [/PATCH .*\/pulls\/5$/, () => pr], [/POST .*graphql/, () => ({ data: {} })], [/POST .*issues\/3\/comments/, () => ({ id: 11, html_url: 'cu' })]]);
    await forge.updatePullRequest('a', 'b', 5, { body: 'new body', draft: false });
    expect(calls.some((c) => /graphql/.test(c.url) && JSON.stringify(c.body).includes('markPullRequestReadyForReview'))).toBe(true);
    expect(await forge.commentOnIssue('a', 'b', 3, 'hi')).toEqual({ id: '11', url: 'cu' });
  });
  it('clone URL carries a short-lived token that is never persisted by us', async () => {
    const { forge } = setup([]);
    expect((await forge.cloneAuth('a', 'b')).url).toBe('https://x-access-token:ghs_x@github.com/a/b.git');
  });
  it('lists installation repositories with search and reads files', async () => {
    const repo = (n: string) => ({ name: n, full_name: `a/${n}`, default_branch: 'main', clone_url: `https://github.com/a/${n}.git`, private: true, owner: { login: 'a' } });
    const { forge } = setup([[/GET .*installation\/repositories/, () => ({ repositories: [repo('pay'), repo('ledger')] })], [/GET .*contents\/AGENTS.md/, () => ({ content: Buffer.from('# hi').toString('base64'), encoding: 'base64' })], [/GET .*contents\/NOPE/, () => ({ __status: 404 })]]);
    expect((await forge.listRepos('pay')).map((r) => r.fullName)).toEqual(['a/pay']);
    expect(await forge.readFile('a', 'b', 'AGENTS.md')).toBe('# hi');
    expect(await forge.readFile('a', 'b', 'NOPE')).toBeUndefined();
    expect((await forge.test()).ok).toBe(true);
  });
  it('token mode (PAT) skips app auth', async () => {
    const { f, calls } = mockFetch([[/GET .*user\/repos/, () => []]]);
    const forge = GitHubApp.withToken('pat123', 'https://ghe.corp/api/v3', f);
    await forge.listRepos();
    expect(calls[0].auth).toBe('token pat123');
    expect((await forge.cloneAuth('a', 'b')).url).toBe('https://x-access-token:pat123@ghe.corp/a/b.git');
  });
});

describe('webhooks', () => {
  it('verifies signatures in constant time and rejects tampering', () => {
    const body = JSON.stringify({ a: 1 });
    const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(verifyWebhookSignature('s3cret', body, sig)).toBe(true);
    expect(verifyWebhookSignature('s3cret', body + ' ', sig)).toBe(false);
    expect(verifyWebhookSignature('other', body, sig)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, 'sha256=short')).toBe(false);
  });
  const repo = { full_name: 'acme/payments-service' };
  const issue = { number: 12, title: 'T', body: 'B', html_url: 'u', labels: [{ name: 'zerovity' }], user: { login: 'bob' } };
  it('maps label, comment, mention, PR close and check events', () => {
    expect(parseWebhook('issues', { action: 'labeled', label: { name: 'zerovity' }, issue, repository: repo, installation: { id: 9 } })).toMatchObject({ type: 'issue_labeled', label: 'zerovity', installationId: '9', issue: { number: 12, labels: ['zerovity'] } });
    expect(parseWebhook('issue_comment', { action: 'created', issue, comment: { id: 1, body: 'plain', user: { login: 'bob', type: 'User' } }, repository: repo })).toMatchObject({ type: 'issue_commented' });
    expect(parseWebhook('issue_comment', { action: 'created', issue, comment: { id: 1, body: '@zerovity payments please', user: { login: 'bob' } }, repository: repo })).toMatchObject({ type: 'issue_mentioned' });
    expect(parseWebhook('issue_comment', { action: 'created', issue: { ...issue, pull_request: {} }, comment: { id: 1, body: 'x', user: { login: 'z' } }, repository: repo })).toMatchObject({ type: 'pull_request_commented' });
    expect(parseWebhook('pull_request', { action: 'closed', pull_request: { number: 3, merged: true, head: { ref: 'zerovity/zf-1' }, html_url: 'u' }, repository: repo })).toMatchObject({ type: 'pull_request_closed', pr: { merged: true } });
    expect(parseWebhook('check_suite', { action: 'completed', check_suite: { head_sha: 'abc', conclusion: 'success' }, repository: repo })).toMatchObject({ type: 'check_suite_completed', conclusion: 'success' });
    expect(parseWebhook('issues', { action: 'opened', issue, repository: repo }).type).toBe('ignored');
    expect(parseWebhook('ping', {}).type).toBe('ignored');
  });
  it('flags bot comments so the foreman never answers itself', () => {
    const e = parseWebhook('issue_comment', { action: 'created', issue, comment: { id: 1, body: 'status', user: { login: 'zerovity[bot]', type: 'Bot' } }, repository: repo });
    expect(e).toMatchObject({ comment: { isBot: true } });
  });
  it('label and mention matching with aliases', () => {
    expect(matchLabel('zerovity')).toBe(true);
    expect(matchLabel('zerovity:payments', 'payments')).toBe(true);
    expect(matchLabel('zerovity:other', 'payments')).toBe(false);
    expect(matchMention('hey @zerovity payments do it', 'payments')).toBe(true);
    expect(matchMention('hey @zerovity other do it', 'payments')).toBe(false);
    expect(matchMention('@zerovity', 'payments')).toBe(true);
    expect(matchMention('no mention', 'payments')).toBe(false);
  });
});

describe('LocalForge', () => {
  it('opens one stable PR per branch with a local URL', async () => {
    const f = new LocalForge();
    const a = await f.openPullRequest({ owner: 'a', name: 'b', head: 'x', base: 'main', title: 't', body: '', draft: true });
    const b = await f.openPullRequest({ owner: 'a', name: 'b', head: 'x', base: 'main', title: 't', body: '', draft: true });
    expect(a).toEqual(b);
    expect(a.url).toMatch(/^local:\/\//);
    expect((await f.updatePullRequest('a', 'b', a.number, { draft: false })).draft).toBe(false);
  });
});

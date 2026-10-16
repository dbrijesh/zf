import { describe, it, expect } from 'vitest';
import { JiraClient, toAdf, fromAdf, parseJiraWebhook, jiraAuthorizeUrl, jiraExchangeCode, jiraRefresh, jiraAccessibleSites } from '../src';

function mock(routes: Array<[RegExp, (init: RequestInit) => unknown]>) {
  const calls: Array<{ method: string; url: string; body?: any; auth?: string }> = [];  
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ method: String(init.method ?? 'GET'), url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string>)?.authorization });
    for (const [re, h] of routes) if (re.test(`${init.method ?? 'GET'} ${url}`)) return new Response(JSON.stringify(h(init)), { status: 200 });
    return new Response('{"error":"nope"}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const issue = { id: '1', key: 'PAY-7', fields: { summary: 'S', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] }, labels: ['zerovity'], status: { name: 'To Do' }, project: { key: 'PAY' }, reporter: { displayName: 'Rae' } } };

describe('Jira client', () => {
  it('Cloud: uses the api.atlassian.com gateway, OAuth bearer, ADF comments', async () => {
    const { f, calls } = mock([[/GET .*\/issue\/PAY-7\?/, () => issue], [/POST .*\/comment$/, () => ({ id: '55' })]]);
    const j = new JiraClient({ mode: 'cloud', cloudId: 'cid', accessToken: 'tok', siteUrl: 'https://acme.atlassian.net' }, f);
    const i = await j.getIssue('PAY-7');
    expect(i).toMatchObject({ key: 'PAY-7', description: 'hello', labels: ['zerovity'], url: 'https://acme.atlassian.net/browse/PAY-7', reporter: 'Rae' });
    expect(calls[0].url).toContain('https://api.atlassian.com/ex/jira/cid/rest/api/3/');
    expect(calls[0].auth).toBe('Bearer tok');
    await j.addComment('PAY-7', 'line1\nline2');
    expect(calls[1].body.body.type).toBe('doc');
  });
  it('Data Center: v2 API with a personal access token and plain-text comments', async () => {
    const { f, calls } = mock([[/POST .*\/comment$/, () => ({ id: '9' })], [/GET .*\/project$/, () => [{ key: 'PAY', name: 'Payments', id: '1' }]], [/GET .*\/myself/, () => ({ name: 'svc' })]]);
    const j = new JiraClient({ mode: 'dc', baseUrl: 'https://jira.corp/', pat: 'pat' }, f);
    await j.addComment('PAY-7', 'plain');
    expect(calls[0].url).toBe('https://jira.corp/rest/api/2/issue/PAY-7/comment');
    expect(calls[0].body.body).toBe('plain');
    expect((await j.test()).ok).toBe(true);
    expect(await j.listProjects()).toEqual([{ key: 'PAY', name: 'Payments', id: '1' }]);
  });
  it('transitions by target status name; false when unavailable', async () => {
    const { f, calls } = mock([[/GET .*transitions$/, () => ({ transitions: [{ id: '31', name: 'Start review', to: { name: 'In Review' } }] })], [/POST .*transitions$/, () => ({})]]);
    const j = new JiraClient({ mode: 'dc', baseUrl: 'https://j', pat: 'p' }, f);
    expect(await j.transition('PAY-7', 'in review')).toBe(true);
    expect(calls.at(-1)?.body).toEqual({ transition: { id: '31' } });
    expect(await j.transition('PAY-7', 'Done')).toBe(false);
  });
  it('remote link and search', async () => {
    const { f, calls } = mock([[/POST .*remotelink$/, () => ({})], [/GET .*\/search\?/, () => ({ issues: [issue] })]]);
    const j = new JiraClient({ mode: 'cloud', cloudId: 'c', accessToken: 't', siteUrl: 'https://s' }, f);
    await j.addRemoteLink('PAY-7', { url: 'https://github.com/a/b/pull/1', title: 'PR' });
    expect(calls[0].body.object.url).toBe('https://github.com/a/b/pull/1');
    expect((await j.search('project = PAY')).map((i) => i.key)).toEqual(['PAY-7']);
  });
  it('failures report the status; test() returns ok=false instead of throwing', async () => {
    const { f } = mock([]);
    expect((await new JiraClient({ mode: 'dc', baseUrl: 'https://j', pat: 'p' }, f).test())).toMatchObject({ ok: false });
  });
});

describe('ADF and OAuth', () => {
  it('adf round trips text and line breaks', () => expect(fromAdf(toAdf('a\nb\n\nc')).trim()).toBe('a\nb\nc'));
  it('builds the 3LO consent URL', () => {
    const u = new URL(jiraAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://zf/cb', state: 'st' }));
    expect(u.host).toBe('auth.atlassian.com');
    expect(u.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(u.searchParams.get('scope')).toContain('offline_access');
    expect(u.searchParams.get('state')).toBe('st');
  });
  it('exchanges and refreshes tokens, lists sites', async () => {
    const f = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600, _grant: JSON.parse(String(init.body)).grant_type }));
      return new Response(JSON.stringify([{ id: 'cid', name: 'acme', url: 'https://acme.atlassian.net' }]));
    }) as unknown as typeof fetch;
    const t = await jiraExchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' }, f);
    expect(t).toMatchObject({ accessToken: 'A', refreshToken: 'R' });
    expect(t.expiresAt).toBeGreaterThan(Date.now());
    expect((await jiraRefresh({ clientId: 'c', clientSecret: 's', refreshToken: 'R' }, f)).accessToken).toBe('A');
    expect((await jiraAccessibleSites('A', f))[0].id).toBe('cid');
  });
});

describe('Jira webhooks', () => {
  const payload = { issue };
  it('issue created, label added, comment created', () => {
    expect(parseJiraWebhook({ webhookEvent: 'jira:issue_created', ...payload }, 'https://s')).toMatchObject({ type: 'issue_created', issue: { key: 'PAY-7', url: 'https://s/browse/PAY-7' } });
    expect(parseJiraWebhook({ webhookEvent: 'jira:issue_updated', ...payload, changelog: { items: [{ field: 'labels', fromString: 'a', toString: 'a zerovity' }] } })).toMatchObject({ type: 'issue_labeled', added: ['zerovity'] });
    expect(parseJiraWebhook({ webhookEvent: 'jira:issue_updated', ...payload, changelog: { items: [{ field: 'status' }] } }).type).toBe('ignored');
    expect(parseJiraWebhook({ webhookEvent: 'comment_created', ...payload, comment: { id: 3, body: 'hi', author: { displayName: 'Rae' } } })).toMatchObject({ type: 'comment_created', comment: { body: 'hi', isBot: false } });
    expect(parseJiraWebhook({ webhookEvent: 'comment_created', ...payload, comment: { id: 3, body: 'x', author: { accountType: 'app' } } })).toMatchObject({ comment: { isBot: true } });
  });
});

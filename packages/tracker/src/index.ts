/** Issue-tracker interface and the Jira Cloud / Data Center client (spec 11.1a). Linear, Azure Boards and ServiceNow can implement TrackerClient later. */
export interface TrackerIssue { key: string; id: string; summary: string; description: string; labels: string[]; status: string; url: string; project: string; reporter: string }
export interface TrackerProject { key: string; name: string; id: string }

export interface TrackerClient {
  readonly kind: 'jira';
  test(): Promise<{ ok: boolean; detail: string }>;
  listProjects(): Promise<TrackerProject[]>;
  getIssue(key: string): Promise<TrackerIssue>;
  addComment(key: string, body: string): Promise<{ id: string }>;
  /** move the issue to a status by name; false when no such transition is available */
  transition(key: string, statusName: string): Promise<boolean>;
  addRemoteLink(key: string, link: { url: string; title: string }): Promise<void>;
  search(jql: string, max?: number): Promise<TrackerIssue[]>;
}

export type JiraAuth = { mode: 'cloud'; cloudId: string; accessToken: string; siteUrl?: string } | { mode: 'dc'; baseUrl: string; pat: string };

export class JiraError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Atlassian Document Format paragraph(s) for Jira Cloud comments. */
export function toAdf(text: string) {
  const blocks = text.split(/\n{2,}/).map((p) => ({ type: 'paragraph', content: p.split('\n').flatMap((line, i, a) => [{ type: 'text', text: line || ' ' }, ...(i < a.length - 1 ? [{ type: 'hardBreak' }] : [])]) }));
  return { type: 'doc', version: 1, content: blocks.length ? blocks : [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }] };
}
export function fromAdf(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  const inner = (n.content ?? []).map(fromAdf).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock'].includes(n.type ?? '') ? inner + '\n' : inner;
}

export class JiraClient implements TrackerClient {
  readonly kind = 'jira' as const;
  private f: typeof fetch;
  constructor(private auth: JiraAuth, fetchImpl?: typeof fetch) { this.f = fetchImpl ?? fetch; }
  private get api() { return this.auth.mode === 'cloud' ? `https://api.atlassian.com/ex/jira/${this.auth.cloudId}/rest/api/3` : `${this.auth.baseUrl.replace(/\/$/, '')}/rest/api/2`; }
  private get site() { return this.auth.mode === 'cloud' ? (this.auth.siteUrl ?? '').replace(/\/$/, '') : this.auth.baseUrl.replace(/\/$/, ''); }
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.auth.mode === 'cloud' ? this.auth.accessToken : this.auth.pat;
    const r = await this.f(`${this.api}${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok) throw new JiraError(r.status, `Jira ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
  private map(i: { id: string; key: string; fields: { summary?: string; description?: unknown; labels?: string[]; status?: { name: string }; project?: { key: string }; reporter?: { displayName?: string; name?: string } } }): TrackerIssue {
    const f = i.fields ?? {};
    return { key: i.key, id: i.id, summary: f.summary ?? '', description: typeof f.description === 'string' ? f.description : fromAdf(f.description).trim(), labels: f.labels ?? [], status: f.status?.name ?? '', url: `${this.site}/browse/${i.key}`, project: f.project?.key ?? i.key.split('-')[0], reporter: f.reporter?.displayName ?? f.reporter?.name ?? '' };
  }
  async test() {
    try {
      const me = await this.req<{ displayName?: string; name?: string }>('GET', '/myself');
      const p = await this.listProjects();
      return { ok: true, detail: `signed in as ${me.displayName ?? me.name}; ${p.length} project(s) visible` };
    } catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
  async listProjects() {
    const r = await this.req<Array<{ key: string; name: string; id: string }> | { values: Array<{ key: string; name: string; id: string }> }>('GET', this.auth.mode === 'cloud' ? '/project/search?maxResults=100' : '/project');
    return (Array.isArray(r) ? r : r.values).map((p) => ({ key: p.key, name: p.name, id: p.id }));
  }
  async getIssue(key: string) { return this.map(await this.req('GET', `/issue/${encodeURIComponent(key)}?fields=summary,description,labels,status,project,reporter`)); }
  async addComment(key: string, body: string) {
    const r = await this.req<{ id: string }>('POST', `/issue/${encodeURIComponent(key)}/comment`, { body: this.auth.mode === 'cloud' ? toAdf(body) : body });
    return { id: r.id };
  }
  async transition(key: string, statusName: string) {
    const r = await this.req<{ transitions: Array<{ id: string; name: string; to: { name: string } }> }>('GET', `/issue/${encodeURIComponent(key)}/transitions`);
    const t = r.transitions.find((x) => x.to.name.toLowerCase() === statusName.toLowerCase() || x.name.toLowerCase() === statusName.toLowerCase());
    if (!t) return false;
    await this.req('POST', `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    return true;
  }
  async addRemoteLink(key: string, link: { url: string; title: string }) {
    await this.req('POST', `/issue/${encodeURIComponent(key)}/remotelink`, { globalId: `zerovity:${link.url}`, object: { url: link.url, title: link.title, icon: { title: 'Zerovity Factory' } } });
  }
  async search(jql: string, max = 25) {
    const r = await this.req<{ issues: Parameters<JiraClient['map']>[0][] }>('GET', `/search?jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=summary,description,labels,status,project,reporter`);
    return r.issues.map((i) => this.map(i));
  }
}

/* --------------------------------------------------------------------------------------- OAuth 2.0 (3LO) */

export const JIRA_SCOPES = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'];

export function jiraAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string; scopes?: string[] }): string {
  const u = new URL('https://auth.atlassian.com/authorize');
  u.search = new URLSearchParams({ audience: 'api.atlassian.com', client_id: o.clientId, scope: (o.scopes ?? JIRA_SCOPES).join(' '), redirect_uri: o.redirectUri, state: o.state, response_type: 'code', prompt: 'consent' }).toString();
  return u.toString();
}

export interface JiraTokens { accessToken: string; refreshToken?: string; expiresAt: number }

async function tokenCall(body: Record<string, string>, f: typeof fetch): Promise<JiraTokens> {
  const r = await f('https://auth.atlassian.com/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
  if (!r.ok || !j.access_token) throw new JiraError(r.status, `Atlassian token endpoint: ${j.error_description ?? r.status}`);
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
}
export const jiraExchangeCode = (o: { clientId: string; clientSecret: string; code: string; redirectUri: string }, f: typeof fetch = fetch) => tokenCall({ grant_type: 'authorization_code', client_id: o.clientId, client_secret: o.clientSecret, code: o.code, redirect_uri: o.redirectUri }, f);
export const jiraRefresh = (o: { clientId: string; clientSecret: string; refreshToken: string }, f: typeof fetch = fetch) => tokenCall({ grant_type: 'refresh_token', client_id: o.clientId, client_secret: o.clientSecret, refresh_token: o.refreshToken }, f);
export async function jiraAccessibleSites(accessToken: string, f: typeof fetch = fetch): Promise<Array<{ id: string; name: string; url: string }>> {
  const r = await f('https://api.atlassian.com/oauth/token/accessible-resources', { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
  if (!r.ok) throw new JiraError(r.status, 'could not list Atlassian sites');
  return (await r.json()) as Array<{ id: string; name: string; url: string }>;
}

/* ------------------------------------------------------------------------------------------ webhooks */

export type TrackerEvent =
  | { type: 'issue_created'; issue: Pick<TrackerIssue, 'key' | 'summary' | 'description' | 'labels' | 'project' | 'url' | 'reporter'> }
  | { type: 'issue_labeled'; issue: Pick<TrackerIssue, 'key' | 'summary' | 'description' | 'labels' | 'project' | 'url' | 'reporter'>; added: string[] }
  | { type: 'comment_created'; key: string; project: string; comment: { id: string; body: string; author: string; isBot: boolean } }
  | { type: 'ignored'; reason: string };

export function parseJiraWebhook(p: Record<string, any>, siteUrl = ''): TrackerEvent { // eslint-disable-line @typescript-eslint/no-explicit-any
  const ev = String(p.webhookEvent ?? '');
  const raw = p.issue;
  const issue = raw ? { key: raw.key as string, summary: raw.fields?.summary ?? '', description: typeof raw.fields?.description === 'string' ? raw.fields.description : fromAdf(raw.fields?.description).trim(), labels: (raw.fields?.labels ?? []) as string[], project: raw.fields?.project?.key ?? String(raw.key).split('-')[0], url: `${siteUrl.replace(/\/$/, '')}/browse/${raw.key}`, reporter: raw.fields?.reporter?.displayName ?? '' } : undefined;
  if (ev === 'jira:issue_created' && issue) return { type: 'issue_created', issue };
  if (ev === 'jira:issue_updated' && issue) {
    const items = (p.changelog?.items ?? []) as Array<{ field: string; fromString?: string; toString?: string }>;
    const lab = items.find((i) => i.field === 'labels');
    if (lab) {
      const before = new Set((lab.fromString ?? '').split(/\s+/).filter(Boolean));
      const added = (lab.toString ?? '').split(/\s+/).filter((l) => l && !before.has(l));
      if (added.length) return { type: 'issue_labeled', issue, added };
    }
    return { type: 'ignored', reason: 'issue_updated without label change' };
  }
  if (ev === 'comment_created' && issue && p.comment) {
    const body = typeof p.comment.body === 'string' ? p.comment.body : fromAdf(p.comment.body).trim();
    return { type: 'comment_created', key: issue.key, project: issue.project, comment: { id: String(p.comment.id), body, author: p.comment.author?.displayName ?? '', isBot: p.comment.author?.accountType === 'app' } };
  }
  return { type: 'ignored', reason: ev || 'unknown' };
}

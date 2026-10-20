import crypto from 'node:crypto';
import type { Forge, RepoInfo, PullRequest, IssueInfo, CheckRunInput } from '@zerovity/forge-common';

export interface GitHubAppConfig {
  appId: string;
  /** PEM private key of the GitHub App */
  privateKey: string;
  /** API root; GitHub Enterprise Server uses https://host/api/v3 */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Short-lived RS256 JWT identifying the App (valid 9 minutes, GitHub's maximum is 10). */
export function appJwt(cfg: Pick<GitHubAppConfig, 'appId' | 'privateKey'>, now = Math.floor(Date.now() / 1000)): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: cfg.appId }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(cfg.privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

/** Permissions requested for installation tokens. Deliberately no merge-capable scope beyond PR creation (spec 10.4, 11.1). */
export const INSTALLATION_PERMISSIONS = { contents: 'write', pull_requests: 'write', issues: 'write', checks: 'write', metadata: 'read' } as const;

export class GitHubApp {
  private tokens = new Map<string, { token: string; expires: number }>();
  private f: typeof fetch;
  readonly api: string;
  constructor(private cfg: GitHubAppConfig) {
    this.f = cfg.fetchImpl ?? fetch;
    this.api = (cfg.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  }
  get webBase(): string { return this.api.replace(/\/api\/v3$/, '').replace('https://api.github.com', 'https://github.com'); }

  private async req<T>(method: string, url: string, token: string, body?: unknown, kind: 'token' | 'bearer' = 'token'): Promise<T> {
    const r = await this.f(url.startsWith('http') ? url : `${this.api}${url}`, {
      method, headers: { authorization: kind === 'bearer' ? `Bearer ${token}` : `token ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ZerovityFactory', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new GitHubError(r.status, `GitHub ${method} ${url} -> ${r.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async asApp<T>(method: string, url: string, body?: unknown): Promise<T> {
    return this.req<T>(method, url, appJwt(this.cfg), body, 'bearer');
  }

  async installationToken(installationId: string | number): Promise<string> {
    const k = String(installationId);
    const hit = this.tokens.get(k);
    if (hit && hit.expires > Date.now() + 60_000) return hit.token;
    const r = await this.asApp<{ token: string; expires_at: string }>('POST', `/app/installations/${k}/access_tokens`, { permissions: INSTALLATION_PERMISSIONS });
    this.tokens.set(k, { token: r.token, expires: Date.parse(r.expires_at) });
    return r.token;
  }

  async findInstallation(owner: string, repo?: string): Promise<{ id: number; account: string } | undefined> {
    const paths = repo ? [`/repos/${owner}/${repo}/installation`] : [`/orgs/${owner}/installation`, `/users/${owner}/installation`];
    for (const p of paths) {
      try { const r = await this.asApp<{ id: number; account: { login: string } }>('GET', p); return { id: r.id, account: r.account.login }; } catch (e) { if (!(e instanceof GitHubError && e.status === 404)) throw e; }
    }
    return undefined;
  }

  async listInstallations(): Promise<Array<{ id: number; account: string; repositorySelection: string }>> {
    const r = await this.asApp<Array<{ id: number; account: { login: string }; repository_selection: string }>>('GET', '/app/installations?per_page=100');
    return r.map((i) => ({ id: i.id, account: i.account.login, repositorySelection: i.repository_selection }));
  }

  forge(installationId: string | number): GitHubForge {
    return new GitHubForge(this, String(installationId));
  }

  /** Token-based access (fine-grained PAT) for simple setups and GitHub Enterprise Server. */
  static withToken(token: string, apiBase?: string, fetchImpl?: typeof fetch): GitHubForge {
    const app = new GitHubApp({ appId: '0', privateKey: '', apiBase, fetchImpl });
    app.tokens.set('pat', { token, expires: Number.MAX_SAFE_INTEGER });
    return new GitHubForge(app, 'pat');
  }

  call<T>(method: string, url: string, token: string, body?: unknown) { return this.req<T>(method, url, token, body); }
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const mapRepo = (r: { name: string; full_name: string; default_branch: string; clone_url: string; private: boolean; owner: { login: string } }, installId?: string): RepoInfo => ({ owner: r.owner.login, name: r.name, fullName: r.full_name, defaultBranch: r.default_branch, cloneUrl: r.clone_url, private: r.private, installId });
type RawPr = { number: number; html_url: string; state: string; draft?: boolean; merged?: boolean; merged_at?: string | null; head: { ref: string; sha: string }; base: { ref: string }; title: string; node_id?: string };
const mapPr = (p: RawPr): PullRequest => ({ number: p.number, url: p.html_url, state: p.merged || p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open', draft: !!p.draft, headRef: p.head.ref, baseRef: p.base.ref, title: p.title, headSha: p.head.sha, merged: !!(p.merged || p.merged_at) });

export class GitHubForge implements Forge {
  readonly kind = 'github';
  constructor(private app: GitHubApp, private installId: string) {}
  private async tok() { return this.installId === 'pat' ? (await this.app.installationToken('pat')) : this.app.installationToken(this.installId); }
  private async c<T>(method: string, url: string, body?: unknown) { return this.app.call<T>(method, url, await this.tok(), body); }

  async listRepos(query?: string): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    const path = this.installId === 'pat' ? '/user/repos' : '/installation/repositories';
    for (let page = 1; page <= 10; page++) {
      const r = await this.c<{ repositories?: never[] } | never[]>('GET', `${path}?per_page=100&page=${page}`);
      const list = (Array.isArray(r) ? r : (r.repositories ?? [])) as Array<Parameters<typeof mapRepo>[0]>;
      out.push(...list.map((x) => mapRepo(x, this.installId)));
      if (list.length < 100) break;
    }
    return query ? out.filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase())) : out;
  }
  async getRepo(owner: string, name: string) { return mapRepo(await this.c('GET', `/repos/${owner}/${name}`), this.installId); }
  async cloneAuth(owner: string, name: string) {
    const token = await this.tok();
    const host = new URL(this.app.webBase).host;
    return { url: `https://${host}/${owner}/${name}.git`, token };
  }
  async openPullRequest(p: { owner: string; name: string; head: string; base: string; title: string; body: string; draft: boolean }) {
    try {
      return mapPr(await this.c<RawPr>('POST', `/repos/${p.owner}/${p.name}/pulls`, { head: p.head, base: p.base, title: p.title, body: p.body, draft: p.draft }));
    } catch (e) {
      // an open PR for this branch already exists: reuse it
      if (e instanceof GitHubError && e.status === 422) {
        const existing = await this.c<RawPr[]>('GET', `/repos/${p.owner}/${p.name}/pulls?head=${p.owner}:${encodeURIComponent(p.head)}&state=open`);
        if (existing[0]) return mapPr(existing[0]);
      }
      throw e;
    }
  }
  async updatePullRequest(owner: string, name: string, number: number, patch: { title?: string; body?: string; draft?: boolean; state?: 'open' | 'closed' }) {
    let pr = await this.c<RawPr>('GET', `/repos/${owner}/${name}/pulls/${number}`);
    if (patch.title || patch.body !== undefined || patch.state) pr = await this.c<RawPr>('PATCH', `/repos/${owner}/${name}/pulls/${number}`, { title: patch.title, body: patch.body, state: patch.state });
    if (patch.draft === false && pr.draft && pr.node_id) {
      // marking ready for review is only available through GraphQL
      const gql = this.app.api.endsWith('/api/v3') ? this.app.api.replace('/api/v3', '/api/graphql') : `${this.app.api}/graphql`;
      await this.app.call('POST', gql, await this.tok(), { query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}', variables: { id: pr.node_id } });
      pr = await this.c<RawPr>('GET', `/repos/${owner}/${name}/pulls/${number}`);
    }
    return mapPr(pr);
  }
  async getPullRequest(owner: string, name: string, number: number) { return mapPr(await this.c<RawPr>('GET', `/repos/${owner}/${name}/pulls/${number}`)); }
  async getIssue(owner: string, name: string, number: number): Promise<IssueInfo> {
    const i = await this.c<{ number: number; title: string; body: string | null; html_url: string; labels: Array<{ name: string } | string>; user: { login: string }; state: string }>('GET', `/repos/${owner}/${name}/issues/${number}`);
    return { number: i.number, title: i.title, body: i.body ?? '', url: i.html_url, labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)), author: i.user.login, state: i.state };
  }
  async commentOnIssue(owner: string, name: string, number: number, body: string) {
    const r = await this.c<{ id: number; html_url: string }>('POST', `/repos/${owner}/${name}/issues/${number}/comments`, { body });
    return { id: String(r.id), url: r.html_url };
  }
  async readFile(owner: string, name: string, path: string, ref?: string) {
    try {
      const r = await this.c<{ content?: string; encoding?: string }>('GET', `/repos/${owner}/${name}/contents/${path.split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
      return r.content ? Buffer.from(r.content, (r.encoding as BufferEncoding) ?? 'base64').toString('utf8') : undefined;
    } catch (e) { if (e instanceof GitHubError && e.status === 404) return undefined; throw e; }
  }
  async readTree(owner: string, name: string, ref: string, prefix = ''): Promise<Record<string, string>> {
    const tree = await this.c<{ tree: Array<{ path: string; type: string; sha: string; size?: number }>; truncated?: boolean }>('GET', `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    const out: Record<string, string> = {};
    const base = prefix ? prefix.replace(/\/?$/, '/') : '';
    for (const n of tree.tree) {
      if (n.type !== 'blob' || (base && !n.path.startsWith(base)) || (n.size ?? 0) > 1_000_000) continue;
      const b = await this.c<{ content: string; encoding: string }>('GET', `/repos/${owner}/${name}/git/blobs/${n.sha}`);
      out[base ? n.path.slice(base.length) : n.path] = Buffer.from(b.content, b.encoding as BufferEncoding).toString('utf8');
    }
    return out;
  }
  async commitFiles(o: { owner: string; name: string; base: string; branch: string; message: string; files: Record<string, string | null> }) {
    const { owner, name } = o;
    const baseRef = await this.c<{ object: { sha: string } }>('GET', `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(o.base)}`);
    let parent = baseRef.object.sha;
    try { await this.c('POST', `/repos/${owner}/${name}/git/refs`, { ref: `refs/heads/${o.branch}`, sha: parent }); } catch (e) { if (!(e instanceof GitHubError && e.status === 422)) throw e; parent = (await this.c<{ object: { sha: string } }>('GET', `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(o.branch)}`)).object.sha; }
    const parentCommit = await this.c<{ tree: { sha: string } }>('GET', `/repos/${owner}/${name}/git/commits/${parent}`);
    const entries = await Promise.all(Object.entries(o.files).map(async ([path, content]) => content === null ? { path, mode: '100644', type: 'blob', sha: null } : { path, mode: '100644', type: 'blob', sha: (await this.c<{ sha: string }>('POST', `/repos/${owner}/${name}/git/blobs`, { content, encoding: 'utf-8' })).sha }));
    const tree = await this.c<{ sha: string }>('POST', `/repos/${owner}/${name}/git/trees`, { base_tree: parentCommit.tree.sha, tree: entries });
    const commit = await this.c<{ sha: string }>('POST', `/repos/${owner}/${name}/git/commits`, { message: o.message, tree: tree.sha, parents: [parent] });
    await this.c('PATCH', `/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(o.branch)}`, { sha: commit.sha });
    return { sha: commit.sha };
  }
  async createCheckRun(c: CheckRunInput) {
    const r = await this.c<{ id: number }>('POST', `/repos/${c.owner}/${c.name}/check-runs`, { name: c.checkName, head_sha: c.headSha, status: c.status, conclusion: c.conclusion, output: { title: c.title, summary: c.summary, annotations: c.annotations?.slice(0, 50).map((a) => ({ path: a.path, start_line: a.line, end_line: a.line, annotation_level: a.level, message: a.message })) } });
    return { id: String(r.id) };
  }
  async test() {
    try {
      const repos = await this.listRepos();
      return { ok: true, detail: `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} visible` };
    } catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
}

/* -------------------------------------------------------------------------------------------------- webhooks */

export function verifyWebhookSignature(secret: string, rawBody: Buffer | string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(signatureHeader.slice(7));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

export type ForgeEvent =
  | { type: 'issue_labeled'; repo: string; issue: IssueRef; label: string; installationId?: string }
  | { type: 'issue_commented' | 'issue_mentioned'; repo: string; issue: IssueRef; comment: CommentRef; installationId?: string }
  | { type: 'pull_request_commented'; repo: string; pr: { number: number; headRef?: string }; comment: CommentRef; installationId?: string }
  | { type: 'pull_request_closed'; repo: string; pr: { number: number; merged: boolean; headRef: string; url: string }; installationId?: string }
  | { type: 'pull_request_pushed'; repo: string; pr: { number: number; headRef: string }; authors: string[]; installationId?: string }
  | { type: 'check_suite_completed'; repo: string; headSha: string; conclusion: string; installationId?: string }
  | { type: 'config_pr'; repo: string; pr: { number: number; headSha: string; headRef: string }; installationId?: string }
  | { type: 'ignored'; reason: string };
export interface IssueRef { number: number; title: string; body: string; url: string; labels: string[]; author: string }
export interface CommentRef { id: string; body: string; author: string; isBot: boolean; url?: string }

/** `@zerovity <alias>` mention (alias optional when the repo maps to one factory). */
export function matchMention(body: string, alias?: string | null): boolean {
  const m = /@zerovity(?:[\s:-]+([\w-]+))?/i.exec(body);
  if (!m) return false;
  return !m[1] || !alias || m[1].toLowerCase() === alias.toLowerCase() || !/^[a-z][\w-]*$/i.test(m[1]);
}
/** Label `zerovity` or `zerovity:<alias>`. */
export function matchLabel(label: string, alias?: string | null, base = 'zerovity'): boolean {
  const l = label.trim().toLowerCase(), b = base.trim().toLowerCase(); // GitHub labels are case-insensitive to people
  return l === b || (!!alias && l === `${b}:${alias.toLowerCase()}`);
}

export function parseWebhook(event: string, p: Record<string, any>): ForgeEvent { // eslint-disable-line @typescript-eslint/no-explicit-any
  const repo = p.repository?.full_name as string | undefined;
  const installationId = p.installation?.id ? String(p.installation.id) : undefined;
  if (!repo) return { type: 'ignored', reason: 'no repository' };
  const issueRef = (i: any): IssueRef => ({ number: i.number, title: i.title, body: i.body ?? '', url: i.html_url, labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)), author: i.user?.login ?? '' }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const commentRef = (c: any): CommentRef => ({ id: String(c.id), body: c.body ?? '', author: c.user?.login ?? '', isBot: c.user?.type === 'Bot' || /\[bot\]$/.test(c.user?.login ?? ''), url: c.html_url }); // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (event) {
    case 'issues':
      if (p.action === 'labeled' && p.label?.name) return { type: 'issue_labeled', repo, issue: issueRef(p.issue), label: p.label.name, installationId };
      return { type: 'ignored', reason: `issues.${p.action}` };
    case 'issue_comment': {
      if (p.action !== 'created') return { type: 'ignored', reason: `issue_comment.${p.action}` };
      if (p.issue?.pull_request) return { type: 'pull_request_commented', repo, pr: { number: p.issue.number }, comment: commentRef(p.comment), installationId };
      const c = commentRef(p.comment);
      return { type: /@zerovity/i.test(c.body) ? 'issue_mentioned' : 'issue_commented', repo, issue: issueRef(p.issue), comment: c, installationId };
    }
    case 'pull_request':
      if (p.action === 'closed') return { type: 'pull_request_closed', repo, pr: { number: p.pull_request.number, merged: !!p.pull_request.merged, headRef: p.pull_request.head.ref, url: p.pull_request.html_url }, installationId };
      if (p.action === 'synchronize') return { type: 'pull_request_pushed', repo, pr: { number: p.pull_request.number, headRef: p.pull_request.head.ref }, authors: [p.sender?.login ?? ''], installationId };
      if (p.action === 'opened' || p.action === 'reopened') return { type: 'config_pr', repo, pr: { number: p.pull_request.number, headSha: p.pull_request.head.sha, headRef: p.pull_request.head.ref }, installationId };
      return { type: 'ignored', reason: `pull_request.${p.action}` };
    case 'pull_request_review_comment':
    case 'pull_request_review':
      return p.action === 'created' || p.action === 'submitted' ? { type: 'pull_request_commented', repo, pr: { number: p.pull_request.number, headRef: p.pull_request.head?.ref }, comment: commentRef(p.comment ?? p.review), installationId } : { type: 'ignored', reason: `${event}.${p.action}` };
    case 'check_suite':
      return p.action === 'completed' ? { type: 'check_suite_completed', repo, headSha: p.check_suite.head_sha, conclusion: p.check_suite.conclusion ?? '', installationId } : { type: 'ignored', reason: `check_suite.${p.action}` };
    default:
      return { type: 'ignored', reason: event };
  }
}

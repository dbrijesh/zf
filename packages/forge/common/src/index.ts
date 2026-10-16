/** Forge interface (spec 11.1). GitLab and Azure DevOps plug in here later without touching the orchestrator. */
export interface RepoInfo { owner: string; name: string; fullName: string; defaultBranch: string; cloneUrl: string; private: boolean; installId?: string }

export interface PullRequest { number: number; url: string; state: 'open' | 'closed' | 'merged'; draft: boolean; headRef: string; baseRef: string; title: string; headSha?: string; merged?: boolean }

export interface CheckRunInput { owner: string; name: string; headSha: string; checkName: string; status: 'queued' | 'in_progress' | 'completed'; conclusion?: 'success' | 'failure' | 'neutral'; title: string; summary: string; annotations?: Array<{ path: string; line: number; message: string; level: 'notice' | 'warning' | 'failure' }> }

export interface IssueInfo { number: number; title: string; body: string; url: string; labels: string[]; author: string; state: string }

export interface Forge {
  readonly kind: string;
  listRepos(query?: string): Promise<RepoInfo[]>;
  getRepo(owner: string, name: string): Promise<RepoInfo>;
  /** URL (with a short-lived credential) the worker uses to clone and push; never stored */
  cloneAuth(owner: string, name: string): Promise<{ url: string; expiresAt?: Date }>;
  openPullRequest(p: { owner: string; name: string; head: string; base: string; title: string; body: string; draft: boolean }): Promise<PullRequest>;
  updatePullRequest(owner: string, name: string, number: number, patch: { title?: string; body?: string; draft?: boolean; state?: 'open' | 'closed' }): Promise<PullRequest>;
  getPullRequest(owner: string, name: string, number: number): Promise<PullRequest>;
  getIssue(owner: string, name: string, number: number): Promise<IssueInfo>;
  commentOnIssue(owner: string, name: string, number: number, body: string): Promise<{ id: string; url?: string }>;
  readFile(owner: string, name: string, path: string, ref?: string): Promise<string | undefined>;
  createCheckRun?(c: CheckRunInput): Promise<{ id: string }>;
  /** read every text file under a path at a ref (definition repositories) */
  readTree?(owner: string, name: string, ref: string, prefix?: string): Promise<Record<string, string>>;
  /** create or update a branch with these files and return its head sha (used to propose definition changes as a PR) */
  commitFiles?(o: { owner: string; name: string; base: string; branch: string; message: string; files: Record<string, string | null> }): Promise<{ sha: string }>;
  test(): Promise<{ ok: boolean; detail: string }>;
}

/** Resolve the forge client (with the right credentials) for a repository of a factory. */
export interface ForgeResolver {
  forRepo(factoryId: string, repo: { forge: string; owner: string; name: string; installId?: string | null }): Promise<Forge | undefined>;
}

/**
 * A forge that needs no network: used when a repository has no connection yet, for demos and tests.
 * Pull requests are tracked in memory only and get a stable `local://` URL.
 */
export class LocalForge implements Forge {
  readonly kind = 'local';
  private prs = new Map<string, PullRequest>();
  async listRepos(): Promise<RepoInfo[]> { return []; }
  async getRepo(owner: string, name: string): Promise<RepoInfo> { return { owner, name, fullName: `${owner}/${name}`, defaultBranch: 'main', cloneUrl: '', private: true }; }
  async cloneAuth(): Promise<{ url: string }> { return { url: '' }; }
  async openPullRequest(p: { owner: string; name: string; head: string; base: string; title: string; body?: string; draft: boolean }): Promise<PullRequest> {
    const key = `${p.owner}/${p.name}#${p.head}`;
    const ex = this.prs.get(key);
    if (ex) return ex;
    const number = this.prs.size + 1;
    const pr: PullRequest = { number, url: `local://${p.owner}/${p.name}/pull/${number}`, state: 'open', draft: p.draft, headRef: p.head, baseRef: p.base, title: p.title };
    this.prs.set(key, pr);
    return pr;
  }
  async updatePullRequest(owner: string, name: string, number: number, patch: { title?: string; draft?: boolean; state?: 'open' | 'closed' }): Promise<PullRequest> {
    const pr = await this.getPullRequest(owner, name, number);
    Object.assign(pr, { ...(patch.title ? { title: patch.title } : {}), ...(patch.draft !== undefined ? { draft: patch.draft } : {}), ...(patch.state ? { state: patch.state } : {}) });
    return pr;
  }
  async getPullRequest(_o: string, _n: string, number: number): Promise<PullRequest> {
    const pr = [...this.prs.values()].find((p) => p.number === number);
    if (!pr) throw new Error(`pull request ${number} not found`);
    return pr;
  }
  async getIssue(): Promise<IssueInfo> { throw new Error('local forge has no issues'); }
  async commentOnIssue(): Promise<{ id: string }> { return { id: 'local' }; }
  async readFile(): Promise<string | undefined> { return undefined; }
  async test() { return { ok: true, detail: 'local forge (no network)' }; }
}

export const parseRepoSlug = (s: string): { owner: string; name: string } => {
  const [owner, name] = s.split('/');
  if (!owner || !name) throw new Error(`invalid repository "${s}", expected owner/name`);
  return { owner, name };
};

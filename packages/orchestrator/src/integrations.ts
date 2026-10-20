import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { ulid, errMessage, notFound, invalid, nullLogger, type Logger } from '@zerovity/core';
import { tables as t, appendAudit, type Db } from '@zerovity/db';
import { cronMatches, type Files } from '@zerovity/definition';
import { GitHubApp, matchLabel, matchMention, type ForgeEvent, type GitHubForge } from '@zerovity/forge-github';
import type { Forge, ForgeResolver } from '@zerovity/forge-common';
import { JiraClient, jiraRefresh, type TrackerClient, type TrackerEvent } from '@zerovity/tracker';
import { validateFactory } from '@zerovity/skills';
import type { Services } from './bootstrap';
import type { Notifier, SourceMessage } from './types';

/* ===========================================================================================================
 * Connection catalogue (spec 12.3)
 * ========================================================================================================= */

export interface FieldSpec { name: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string; kind?: 'text' | 'textarea' | 'url' }
export interface ConnectionType { id: string; type: string; provider: string; title: string; group: string; description: string; v1: boolean; authKind: string; fields: FieldSpec[]; flow?: 'popup-oauth' | 'popup-app-install' | 'form' }

export const CONNECTION_TYPES: ConnectionType[] = [
  { id: 'github-app', type: 'forge', provider: 'github', title: 'GitHub App', group: 'Code forge', description: 'Install the Zerovity GitHub App on your organisation. Short-lived tokens, no merge permission.', v1: true, authKind: 'app', flow: 'form',
    fields: [{ name: 'appId', label: 'App ID', required: true }, { name: 'private_key', label: 'Private key (PEM)', secret: true, required: true, kind: 'textarea' }, { name: 'webhook_secret', label: 'Webhook secret', secret: true, required: true }, { name: 'installationId', label: 'Installation ID', help: 'Optional: found automatically from the repository owner' }, { name: 'apiBase', label: 'API base URL', placeholder: 'https://api.github.com', help: 'GitHub Enterprise Server: https://HOST/api/v3', kind: 'url' }] },
  { id: 'github-token', type: 'forge', provider: 'github', title: 'GitHub token (PAT)', group: 'Code forge', description: 'A fine-grained personal access token or service-account token. Simpler than an App; use for pilots.', v1: true, authKind: 'token', flow: 'form',
    fields: [{ name: 'token', label: 'Token', secret: true, required: true }, { name: 'apiBase', label: 'API base URL', placeholder: 'https://api.github.com', kind: 'url' }, { name: 'webhook_secret', label: 'Webhook secret', secret: true }] },
  { id: 'gitlab', type: 'forge', provider: 'gitlab', title: 'GitLab', group: 'Code forge', description: 'Planned.', v1: false, authKind: 'token', fields: [] },
  { id: 'azuredevops', type: 'forge', provider: 'azuredevops', title: 'Azure DevOps', group: 'Code forge', description: 'Planned.', v1: false, authKind: 'token', fields: [] },
  { id: 'jira-cloud', type: 'tracker', provider: 'jira-cloud', title: 'Jira Cloud', group: 'Issue tracker', description: 'OAuth 2.0 (3LO). Intake from labelled issues, status comments, optional status mapping.', v1: true, authKind: 'oauth', flow: 'popup-oauth',
    fields: [{ name: 'clientId', label: 'OAuth client ID', required: true }, { name: 'client_secret', label: 'OAuth client secret', secret: true, required: true }] },
  { id: 'jira-dc', type: 'tracker', provider: 'jira-dc', title: 'Jira Data Center', group: 'Issue tracker', description: 'Personal access token for a service account.', v1: true, authKind: 'token', flow: 'form',
    fields: [{ name: 'baseUrl', label: 'Base URL', required: true, kind: 'url', placeholder: 'https://jira.example.com' }, { name: 'pat', label: 'Personal access token', secret: true, required: true }] },
  { id: 'linear', type: 'tracker', provider: 'linear', title: 'Linear', group: 'Issue tracker', description: 'Planned.', v1: false, authKind: 'token', fields: [] },
  { id: 'slack', type: 'chat', provider: 'slack', title: 'Slack', group: 'Chat', description: 'Planned.', v1: false, authKind: 'oauth', fields: [] },
  { id: 'teams', type: 'chat', provider: 'teams', title: 'Microsoft Teams', group: 'Chat', description: 'Planned.', v1: false, authKind: 'oauth', fields: [] },
  { id: 'anthropic', type: 'harness', provider: 'anthropic', title: 'Anthropic API key', group: 'AI harness credentials', description: 'Used by Claude Code.', v1: true, authKind: 'key', flow: 'form', fields: [{ name: 'api_key', label: 'API key', secret: true, required: true }, { name: 'baseUrl', label: 'Base URL (gateway)', kind: 'url' }] },
  { id: 'bedrock', type: 'harness', provider: 'bedrock', title: 'Amazon Bedrock', group: 'AI harness credentials', description: 'Claude Code through Bedrock.', v1: true, authKind: 'key', flow: 'form', fields: [{ name: 'AWS_ACCESS_KEY_ID', label: 'Access key ID', secret: true, required: true }, { name: 'AWS_SECRET_ACCESS_KEY', label: 'Secret access key', secret: true, required: true }, { name: 'AWS_REGION', label: 'Region', required: true, placeholder: 'us-east-1' }] },
  { id: 'vertex', type: 'harness', provider: 'vertex', title: 'Google Vertex AI', group: 'AI harness credentials', description: 'Claude Code through Vertex.', v1: true, authKind: 'key', flow: 'form', fields: [{ name: 'ANTHROPIC_VERTEX_PROJECT_ID', label: 'Project ID', required: true }, { name: 'CLOUD_ML_REGION', label: 'Region', required: true }] },
  { id: 'openai', type: 'harness', provider: 'openai', title: 'OpenAI API key', group: 'AI harness credentials', description: 'Used by Codex CLI.', v1: true, authKind: 'key', flow: 'form', fields: [{ name: 'api_key', label: 'API key', secret: true, required: true }, { name: 'baseUrl', label: 'Base URL (gateway)', kind: 'url' }] },
  { id: 'copilot', type: 'harness', provider: 'copilot', title: 'GitHub Copilot token', group: 'AI harness credentials', description: 'A token for a user or service account with a Copilot seat. Used by Copilot CLI.', v1: true, authKind: 'token', flow: 'form', fields: [{ name: 'token', label: 'Token', secret: true, required: true }, { name: 'expiresAt', label: 'Token expires', placeholder: '2026-12-31', help: 'Used for expiry warnings' }] },
  { id: 'cursor', type: 'harness', provider: 'cursor', title: 'Cursor API key', group: 'AI harness credentials', description: 'A Cursor API key for the Cursor CLI (Settings, Cursor Dashboard). Used by agents that run on the Cursor harness.', v1: true, authKind: 'key', flow: 'form', fields: [{ name: 'api_key', label: 'API key', secret: true, required: true }] },
  { id: 'gateway', type: 'gateway', provider: 'zerovity-gateway', title: 'Zerovity gateway', group: 'Model gateway', description: 'Route model traffic through the Zerovity gateway for token economics.', v1: true, authKind: 'none', flow: 'form', fields: [{ name: 'anthropicBaseUrl', label: 'Anthropic base URL', kind: 'url' }, { name: 'openaiBaseUrl', label: 'OpenAI base URL', kind: 'url' }] },
  { id: 'mcp-http', type: 'mcp', provider: 'mcp-http', title: 'MCP server (remote)', group: 'MCP servers', description: 'Any remote MCP server over streamable HTTP.', v1: true, authKind: 'token', flow: 'form', fields: [{ name: 'url', label: 'URL', required: true, kind: 'url' }, { name: 'header', label: 'Auth header name', placeholder: 'Authorization' }, { name: 'token', label: 'Header value', secret: true, help: 'e.g. Bearer abc123' }] },
  { id: 'mcp-stdio', type: 'mcp', provider: 'mcp-stdio', title: 'MCP server (command)', group: 'MCP servers', description: 'A local stdio MCP server started inside the runner.', v1: true, authKind: 'none', flow: 'form', fields: [{ name: 'command', label: 'Command', required: true }, { name: 'args', label: 'Arguments (space separated)' }] },
  { id: 'registry', type: 'registry', provider: 'oci', title: 'Container registry', group: 'Container registry', description: 'Credentials for private runner images.', v1: true, authKind: 'token', flow: 'form', fields: [{ name: 'host', label: 'Registry host', required: true, placeholder: 'ghcr.io' }, { name: 'username', label: 'Username', required: true }, { name: 'password', label: 'Password or token', secret: true, required: true }] },
  { id: 'oidc', type: 'identity', provider: 'oidc', title: 'OIDC identity provider', group: 'Identity', description: 'Entra ID, Okta, Keycloak. Organisation admins only.', v1: true, authKind: 'oidc', flow: 'form', fields: [{ name: 'issuer', label: 'Issuer URL', required: true, kind: 'url' }, { name: 'clientId', label: 'Client ID', required: true }, { name: 'client_secret', label: 'Client secret', secret: true, required: true }, { name: 'groupsClaim', label: 'Groups claim', placeholder: 'groups' }] },
];

const PRIMARY_SECRET: Record<string, string> = { 'github-app': 'private_key', 'github-token': 'token', 'jira-cloud': 'access_token', 'jira-dc': 'pat', anthropic: 'api_key', openai: 'api_key', copilot: 'token', cursor: 'api_key', 'mcp-http': 'token', registry: 'password', oidc: 'client_secret' };

export type ConnectionRow = typeof t.connections.$inferSelect;
export interface ConnectionView { id: string; typeId: string; type: string; provider: string; displayName: string; authKind: string; status: string; scopes: string[]; config: Record<string, unknown>; secrets: Array<{ name: string; last4: string }>; lastCheckedAt: Date | null; lastError: string | null; expiresAt: Date | null; createdBy: string | null; createdAt: Date; dependents?: Dependents }
export interface Dependents { factories: Array<{ id: string; name: string }>; agents: Array<{ factory: string; agent: string }>; automations: Array<{ factory: string; automation: string }> }

const typeIdOf = (c: ConnectionRow): string => (c.config as { typeId?: string }).typeId ?? CONNECTION_TYPES.find((x) => x.provider === c.provider && x.authKind === c.authKind)?.id ?? c.provider;

export class ConnectionService {
  private ghApps = new Map<string, GitHubApp>();
  constructor(private s: Pick<Services, 'db' | 'secrets' | 'defs'>, private o: { fetchImpl?: typeof fetch; log?: Logger } = {}) {}
  private get db() { return this.s.db; }

  catalogue(): ConnectionType[] { return CONNECTION_TYPES; }

  async list(orgId: string): Promise<ConnectionView[]> {
    const rows = await this.db.select().from(t.connections).where(eq(t.connections.orgId, orgId)).orderBy(desc(t.connections.createdAt));
    const out: ConnectionView[] = [];
    for (const c of rows) out.push(await this.view(c));
    return out;
  }
  async view(c: ConnectionRow, withDeps = false): Promise<ConnectionView> {
    const secs = await this.s.secrets.list('connection', c.id);
    const { typeId: _t, ...config } = c.config as Record<string, unknown>;
    return { id: c.id, typeId: typeIdOf(c), type: c.type, provider: c.provider, displayName: c.displayName, authKind: c.authKind, status: c.status, scopes: c.scopes, config, secrets: secs.map((x) => ({ name: x.name, last4: x.last4 })), lastCheckedAt: c.lastCheckedAt, lastError: c.lastError, expiresAt: c.expiresAt, createdBy: c.createdBy, createdAt: c.createdAt, dependents: withDeps ? await this.dependents(c) : undefined };
  }
  async get(id: string): Promise<ConnectionRow> {
    const [c] = await this.db.select().from(t.connections).where(eq(t.connections.id, id));
    if (!c) throw notFound('Connection', id);
    return c;
  }

  async create(orgId: string, i: { typeId: string; displayName: string; values: Record<string, string>; by: string }): Promise<ConnectionView> {
    const ct = CONNECTION_TYPES.find((x) => x.id === i.typeId);
    if (!ct || !ct.v1) throw invalid(`Unknown or unavailable connection type "${i.typeId}"`);
    for (const f of ct.fields) if (f.required && !i.values[f.name]?.trim()) throw invalid(`${f.label} is required`);
    // URL settings are fetched by the server: only http(s), never file:, ftp:, gopher: ...
    for (const f of ct.fields) {
      const v = i.values[f.name]?.trim();
      if (f.kind !== 'url' || !v) continue;
      let u: URL;
      try { u = new URL(v); } catch { throw invalid(`${f.label} is not a valid URL`); }
      if (!/^https?:$/.test(u.protocol)) throw invalid(`${f.label} must start with http:// or https://`);
    }
    const id = ulid();
    const config: Record<string, unknown> = { typeId: ct.id };
    for (const f of ct.fields) if (!f.secret && i.values[f.name] !== undefined && i.values[f.name] !== '') config[f.name] = i.values[f.name];
    if (ct.id === 'copilot' && i.values.expiresAt) config.expiresAt = i.values.expiresAt;
    await this.db.insert(t.connections).values({ id, orgId, type: ct.type, provider: ct.provider, displayName: i.displayName.trim() || ct.title, authKind: ct.authKind, config, status: 'not_connected', createdBy: i.by });
    for (const f of ct.fields) if (f.secret && i.values[f.name]) await this.s.secrets.set('connection', id, f.name, i.values[f.name], i.by);
    await this.linkPrimarySecret(id, ct.id);
    await appendAudit(this.db, { chain: `org:${orgId}`, factoryId: null, actor: i.by, action: 'connection.created', subject: id, payload: { type: ct.id, name: i.displayName, secrets: ct.fields.filter((f) => f.secret && i.values[f.name]).map((f) => f.name) } });
    if (ct.flow !== 'popup-oauth') await this.test(id, i.by).catch(() => undefined);
    return this.view(await this.get(id));
  }

  private async linkPrimarySecret(id: string, typeId: string) {
    const name = PRIMARY_SECRET[typeId];
    if (!name) return;
    const [sec] = await this.db.select().from(t.secrets).where(and(eq(t.secrets.scope, 'connection'), eq(t.secrets.scopeId, id), eq(t.secrets.name, name)));
    if (sec) await this.db.update(t.connections).set({ secretId: sec.id }).where(eq(t.connections.id, id));
  }

  /** Replace secret values (rotate) and/or settings. The old values are never readable again. */
  async rotate(id: string, values: Record<string, string>, by: string): Promise<ConnectionView> {
    const c = await this.get(id);
    const ct = CONNECTION_TYPES.find((x) => x.id === typeIdOf(c));
    const config = { ...(c.config as Record<string, unknown>) };
    for (const [k, v] of Object.entries(values)) {
      const f = ct?.fields.find((x) => x.name === k);
      if (f?.secret) await this.s.secrets.set('connection', id, k, v, by);
      else if (v !== '') config[k] = v;
    }
    await this.db.update(t.connections).set({ config, updatedAt: new Date() }).where(eq(t.connections.id, id));
    await this.linkPrimarySecret(id, typeIdOf(c));
    this.ghApps.delete(id);
    await appendAudit(this.db, { chain: `org:${c.orgId}`, factoryId: null, actor: by, action: 'connection.rotated', subject: id, payload: { fields: Object.keys(values) } });
    await this.test(id, by).catch(() => undefined);
    return this.view(await this.get(id));
  }

  async remove(id: string, by: string, force = false): Promise<{ removed: boolean; dependents: Dependents }> {
    const c = await this.get(id);
    const deps = await this.dependents(c);
    if (!force && (deps.factories.length || deps.agents.length || deps.automations.length)) return { removed: false, dependents: deps };
    for (const sec of await this.s.secrets.list('connection', id)) await this.s.secrets.delete('connection', id, sec.name);
    await this.db.delete(t.factoryConnections).where(eq(t.factoryConnections.connectionId, id));
    await this.db.delete(t.connections).where(eq(t.connections.id, id));
    await this.db.update(t.inboxItems).set({ status: 'resolved', resolvedAt: new Date(), resolution: 'connection removed' }).where(eq(t.inboxItems.refKey, `conn:${id}`));
    await appendAudit(this.db, { chain: `org:${c.orgId}`, factoryId: null, actor: by, action: 'connection.removed', subject: id, payload: { name: c.displayName, force } });
    return { removed: true, dependents: deps };
  }

  /** What breaks if this connection goes away (spec 12.3 "Health and audit"). */
  async dependents(c: ConnectionRow): Promise<Dependents> {
    const out: Dependents = { factories: [], agents: [], automations: [] };
    const maps = await this.db.select({ f: t.factories }).from(t.factoryConnections).innerJoin(t.factories, eq(t.factoryConnections.factoryId, t.factories.id)).where(eq(t.factoryConnections.connectionId, c.id));
    out.factories = maps.map((m) => ({ id: m.f.id, name: m.f.name }));
    const facs = await this.db.select().from(t.factories).where(eq(t.factories.orgId, c.orgId));
    for (const f of facs) {
      const a = await this.s.defs.getActive(f.id);
      if (!a) continue;
      for (const ag of a.agents.values()) if (ag.fm.credential === c.displayName) out.agents.push({ factory: f.name, agent: ag.name });
      if ((a.definition.factory.integrations?.jira ?? []).some((j) => j.connection === c.displayName) && !out.factories.some((x) => x.id === f.id)) out.factories.push({ id: f.id, name: f.name });
      if (c.type === 'forge') for (const au of Object.values(a.definition.automations)) if (au.fm.triggers.some((tr) => tr.provider === 'github')) out.automations.push({ factory: f.name, automation: au.name });
    }
    return out;
  }

  /* ---------- test / health ---------- */

  async test(id: string, by = 'system'): Promise<{ ok: boolean; detail: string; status: string }> {
    const c = await this.get(id);
    let r: { ok: boolean; detail: string; expiresAt?: Date | null; scopes?: string[] };
    try { r = await this.runTest(c); } catch (e) { r = { ok: false, detail: errMessage(e) }; }
    const prev = c.status;
    const soon = r.expiresAt && r.expiresAt.getTime() - Date.now() < 7 * 86_400_000;
    const status = !r.ok ? (/expired|401|invalid.*token|bad credentials/i.test(r.detail) ? 'expired' : 'needs_attention') : r.expiresAt && r.expiresAt.getTime() < Date.now() ? 'expired' : soon ? 'needs_attention' : 'connected';
    const detail = r.ok && soon ? `${r.detail}; expires ${r.expiresAt!.toISOString().slice(0, 10)}` : r.detail;
    await this.db.update(t.connections).set({ status, lastCheckedAt: new Date(), lastError: status === 'connected' ? null : detail, expiresAt: r.expiresAt ?? c.expiresAt, scopes: r.scopes ?? c.scopes, updatedAt: new Date() }).where(eq(t.connections.id, id));
    if (status !== prev) await appendAudit(this.db, { chain: `org:${c.orgId}`, factoryId: null, actor: by, action: 'connection.status', subject: id, payload: { from: prev, to: status, detail: detail.slice(0, 300) } });
    await this.syncInbox(c, status, detail);
    return { ok: status === 'connected', detail, status };
  }

  /** Raise or clear the inbox item for the connection owner. */
  private async syncInbox(c: ConnectionRow, status: string, detail: string) {
    const ref = `conn:${c.id}`;
    const [open] = await this.db.select().from(t.inboxItems).where(and(eq(t.inboxItems.refKey, ref), eq(t.inboxItems.status, 'open')));
    if (status === 'connected') { if (open) await this.db.update(t.inboxItems).set({ status: 'resolved', resolvedAt: new Date(), resolution: 'healthy again' }).where(eq(t.inboxItems.id, open.id)); return; }
    const title = `${c.displayName}: ${status === 'expired' ? 'credentials expired' : 'needs attention'}`;
    if (open) { await this.db.update(t.inboxItems).set({ title, body: detail, updatedAt: new Date() }).where(eq(t.inboxItems.id, open.id)); return; }
    await this.db.insert(t.inboxItems).values({ id: ulid(), orgId: c.orgId, userId: c.createdBy, kind: 'connection', title, body: detail, refKey: ref, payload: { connectionId: c.id, provider: c.provider, status } });
  }

  /** Background check of every connection (run every 15 minutes, spec 12.3). */
  async checkAll(orgId?: string): Promise<{ checked: number; failing: number }> {
    const rows = await this.db.select().from(t.connections).where(orgId ? eq(t.connections.orgId, orgId) : sql`true`);
    let failing = 0;
    for (const c of rows) { if ((await this.test(c.id)).status !== 'connected') failing++; }
    return { checked: rows.length, failing };
  }

  private async runTest(c: ConnectionRow): Promise<{ ok: boolean; detail: string; expiresAt?: Date | null; scopes?: string[] }> {
    const f = this.o.fetchImpl ?? fetch;
    const typeId = typeIdOf(c);
    const cfg = c.config as Record<string, string>;
    const sec = (n: string) => this.s.secrets.get('connection', c.id, n);
    switch (typeId) {
      case 'github-app': case 'github-token': { const forge = await this.githubForge(c); const r = await forge.test(); return r; }
      case 'jira-cloud': {
        if (!(await sec('access_token'))) return { ok: false, detail: 'Not authorised yet: complete the Atlassian consent flow' };
        const client = await this.jiraClient(c);
        const r = await client.test();
        return { ...r, expiresAt: cfg.tokenExpiresAt ? new Date(cfg.tokenExpiresAt) : null };
      }
      case 'jira-dc': { const r = await (await this.jiraClient(c)).test(); return r; }
      case 'anthropic': {
        const key = await sec('api_key');
        const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
        const r = await f(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) });
        return r.ok ? { ok: true, detail: 'tiny model request succeeded' } : { ok: false, detail: `model request failed (${r.status})${r.status === 401 ? ': invalid API key' : ''}` };
      }
      case 'openai': {
        const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
        const r = await f(`${base}/models`, { headers: { authorization: `Bearer ${(await sec('api_key')) ?? ''}` } });
        return r.ok ? { ok: true, detail: 'API key accepted' } : { ok: false, detail: `request failed (${r.status})${r.status === 401 ? ': invalid API key' : ''}` };
      }
      case 'copilot': {
        const r = await f('https://api.github.com/user', { headers: { authorization: `Bearer ${(await sec('token')) ?? ''}`, 'user-agent': 'ZerovityFactory' } });
        const exp = cfg.expiresAt ? new Date(cfg.expiresAt) : r.headers.get('github-authentication-token-expiration') ? new Date(r.headers.get('github-authentication-token-expiration')!) : null;
        return r.ok ? { ok: true, detail: `token valid for ${((await r.json()) as { login?: string }).login ?? 'user'} (Copilot seat is verified on first run)`, expiresAt: exp } : { ok: false, detail: `GitHub rejected the token (${r.status})` };
      }
      case 'cursor': return (await sec('api_key')) ? { ok: true, detail: 'key stored (Cursor has no key-check endpoint we can call; it is validated on the first run)' } : { ok: false, detail: 'missing API key' };
      case 'bedrock': return cfg.AWS_REGION && (await sec('AWS_ACCESS_KEY_ID')) && (await sec('AWS_SECRET_ACCESS_KEY')) ? { ok: true, detail: 'credentials stored (validated on first run)' } : { ok: false, detail: 'missing credentials' };
      case 'vertex': return cfg.ANTHROPIC_VERTEX_PROJECT_ID ? { ok: true, detail: 'project configured (uses ambient Google credentials)' } : { ok: false, detail: 'missing project' };
      case 'gateway': {
        const urls = [cfg.anthropicBaseUrl, cfg.openaiBaseUrl].filter(Boolean);
        if (!urls.length) return { ok: false, detail: 'no base URL configured' };
        for (const u of urls) { const r = await f(u, { method: 'GET' }).catch(() => undefined); if (!r) return { ok: false, detail: `${u} is unreachable` }; }
        return { ok: true, detail: `${urls.length} gateway URL(s) reachable` };
      }
      case 'mcp-http': {
        const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
        const tok = await sec('token');
        if (tok) headers[cfg.header || 'Authorization'] = tok;
        const r = await f(cfg.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zerovity-factory', version: '0.1.0' } } }) });
        return r.ok ? { ok: true, detail: 'MCP initialize succeeded' } : { ok: false, detail: `initialize failed (${r.status})` };
      }
      case 'mcp-stdio': return { ok: !!cfg.command, detail: cfg.command ? 'command configured (started inside the runner)' : 'no command' };
      case 'registry': {
        const r = await f(`https://${cfg.host}/v2/`, { headers: { authorization: `Basic ${Buffer.from(`${cfg.username}:${(await sec('password')) ?? ''}`).toString('base64')}` } });
        return r.ok ? { ok: true, detail: 'registry accepted the credentials' } : { ok: false, detail: `registry returned ${r.status}` };
      }
      case 'oidc': {
        const r = await f(`${cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
        return r.ok ? { ok: true, detail: 'discovery document found' } : { ok: false, detail: `discovery failed (${r.status})` };
      }
      default: return { ok: false, detail: 'no test available for this connection type' };
    }
  }

  /* ---------- clients ---------- */

  async githubForge(c: ConnectionRow, installId?: string): Promise<GitHubForge> {
    const cfg = c.config as Record<string, string>;
    if (typeIdOf(c) === 'github-token') return GitHubApp.withToken((await this.s.secrets.get('connection', c.id, 'token')) ?? '', cfg.apiBase || undefined, this.o.fetchImpl);
    let app = this.ghApps.get(c.id);
    if (!app) { app = new GitHubApp({ appId: cfg.appId, privateKey: (await this.s.secrets.get('connection', c.id, 'private_key')) ?? '', apiBase: cfg.apiBase || undefined, fetchImpl: this.o.fetchImpl }); this.ghApps.set(c.id, app); }
    let inst = installId ?? cfg.installationId;
    if (!inst) { const list = await app.listInstallations(); if (!list.length) throw new Error('The GitHub App is not installed on any account yet'); inst = String(list[0].id); }
    return app.forge(inst);
  }
  async githubApp(c: ConnectionRow): Promise<GitHubApp> {
    await this.githubForge(c).catch(() => undefined);
    return this.ghApps.get(c.id)!;
  }

  async jiraClient(c: ConnectionRow): Promise<JiraClient> {
    const cfg = c.config as Record<string, string>;
    if (typeIdOf(c) === 'jira-dc') return new JiraClient({ mode: 'dc', baseUrl: cfg.baseUrl, pat: (await this.s.secrets.get('connection', c.id, 'pat')) ?? '' }, this.o.fetchImpl);
    let access = (await this.s.secrets.get('connection', c.id, 'access_token')) ?? '';
    const exp = cfg.tokenExpiresAt ? Date.parse(cfg.tokenExpiresAt) : 0;
    if (exp && exp - Date.now() < 60_000) {
      const refresh = await this.s.secrets.get('connection', c.id, 'refresh_token');
      if (!refresh) throw new Error('Jira access token expired and no refresh token is stored: reconnect');
      const tok = await jiraRefresh({ clientId: cfg.clientId, clientSecret: (await this.s.secrets.get('connection', c.id, 'client_secret')) ?? '', refreshToken: refresh }, this.o.fetchImpl);
      access = tok.accessToken;
      await this.s.secrets.set('connection', c.id, 'access_token', tok.accessToken);
      if (tok.refreshToken) await this.s.secrets.set('connection', c.id, 'refresh_token', tok.refreshToken);
      await this.db.update(t.connections).set({ config: { ...c.config, tokenExpiresAt: new Date(tok.expiresAt).toISOString() } }).where(eq(t.connections.id, c.id));
    }
    return new JiraClient({ mode: 'cloud', cloudId: cfg.cloudId, accessToken: access, siteUrl: cfg.siteUrl }, this.o.fetchImpl);
  }

  /** Store the result of the Jira 3LO consent flow. */
  async completeJiraOAuth(id: string, tokens: { accessToken: string; refreshToken?: string; expiresAt: number }, site: { id: string; url: string; name: string }, by: string): Promise<ConnectionView> {
    const c = await this.get(id);
    await this.s.secrets.set('connection', id, 'access_token', tokens.accessToken, by);
    if (tokens.refreshToken) await this.s.secrets.set('connection', id, 'refresh_token', tokens.refreshToken, by);
    await this.db.update(t.connections).set({ config: { ...c.config, cloudId: site.id, siteUrl: site.url, siteName: site.name, tokenExpiresAt: new Date(tokens.expiresAt).toISOString() }, updatedAt: new Date() }).where(eq(t.connections.id, id));
    await this.linkPrimarySecret(id, 'jira-cloud');
    await appendAudit(this.db, { chain: `org:${c.orgId}`, factoryId: null, actor: by, action: 'connection.authorised', subject: id, payload: { site: site.url } });
    await this.test(id, by).catch(() => undefined);
    return this.view(await this.get(id));
  }

  async byName(orgId: string, name: string): Promise<ConnectionRow | undefined> {
    return (await this.db.select().from(t.connections).where(and(eq(t.connections.orgId, orgId), eq(t.connections.displayName, name))))[0];
  }
  async firstOfType(orgId: string, type: string): Promise<ConnectionRow | undefined> {
    return (await this.db.select().from(t.connections).where(and(eq(t.connections.orgId, orgId), eq(t.connections.type, type))).orderBy(t.connections.createdAt))[0];
  }

  /* ---------- per-factory mapping, written back to the definition (spec 12.3) ---------- */

  async mapFactory(factoryId: string, connectionId: string, mapping: Record<string, unknown>, by: string): Promise<{ applied: boolean; commit?: string; issues?: unknown[]; pr?: { url: string } }> {
    const c = await this.get(connectionId);
    await this.db.insert(t.factoryConnections).values({ factoryId, connectionId, mapping }).onConflictDoUpdate({ target: [t.factoryConnections.factoryId, t.factoryConnections.connectionId], set: { mapping } });
    const patch = (doc: Record<string, any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const m = mapping as { repos?: Array<{ owner: string; name: string; defaultBranch?: string }>; jira?: Array<{ project: string; label?: string; statusMap?: Record<string, string> }>; triggerLabel?: string };
      if (c.type === 'forge' && m.repos) {
        const keep = (doc.repositories ?? []).filter((r: { forge?: string }) => r.forge && r.forge !== 'github');
        doc.repositories = [...keep, ...m.repos.map((r) => ({ forge: 'github', owner: r.owner, name: r.name, defaultBranch: r.defaultBranch ?? 'main' }))];
        if (m.triggerLabel) (doc.integrations ??= {}).github = { ...(doc.integrations.github ?? {}), connection: c.displayName, triggerLabel: m.triggerLabel };
        else (doc.integrations ??= {}).github = { ...(doc.integrations.github ?? {}), connection: c.displayName };
      }
      if (c.type === 'tracker' && m.jira) {
        const others = ((doc.integrations ??= {}).jira ?? []).filter((j: { connection: string }) => j.connection !== c.displayName);
        doc.integrations.jira = [...others, ...m.jira.map((j) => ({ connection: c.displayName, project: j.project, label: j.label ?? 'zerovity', ...(j.statusMap && Object.keys(j.statusMap).length ? { statusMap: j.statusMap } : {}) }))];
      }
    };
    return this.editDefinition(factoryId, patch, by, `Map connection ${c.displayName}`);
  }

  /** Per-agent harness credential and MCP server choices. */
  async assignAgent(factoryId: string, agent: string, patch: { credential?: string | null; mcpServers?: string[] }, by: string) {
    return this.editDefinition(factoryId, (doc: Record<string, any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const ov = ((doc.agentOverrides ??= {})[agent] ??= {});
      if (patch.credential !== undefined) { if (patch.credential) ov.credential = patch.credential; else delete ov.credential; }
      if (patch.mcpServers) ov.mcpServers = patch.mcpServers;
    }, by, `Assign credentials for ${agent}`);
  }

  async editDefinition(factoryId: string, mutate: (doc: Record<string, any>) => void, by: string, message: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const [f] = await this.db.select().from(t.factories).where(eq(t.factories.id, factoryId));
    if (!f) throw notFound('Factory', factoryId);
    const v = await this.s.defs.getVersion(factoryId);
    if (!v) throw notFound('Definition', factoryId);
    const files: Files = { ...v.files };
    const doc = (parseYaml(files['zerovity.factory.yaml']) ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    mutate(doc);
    for (const k of Object.keys(doc.agentOverrides ?? {})) if (!Object.keys(doc.agentOverrides[k]).length) delete doc.agentOverrides[k];
    if (doc.agentOverrides && !Object.keys(doc.agentOverrides).length) delete doc.agentOverrides;
    files['zerovity.factory.yaml'] = yamlStringify(doc);
    if (f.definitionSource === 'git' && f.definitionRepo) {
      const repo = f.definitionRepo;
      const forge = await new DbForgeResolver({ db: this.db, secrets: this.s.secrets, conns: this }).forRepo(factoryId, { forge: repo.forge, owner: repo.owner, name: repo.name });
      if (!forge?.commitFiles) throw invalid('This definition repository cannot be edited from here');
      const branch = `zerovity/config-${Date.now().toString(36)}`;
      const prefix = repo.path ? repo.path.replace(/\/?$/, '/') : '';
      await forge.commitFiles({ owner: repo.owner, name: repo.name, base: repo.branch, branch, message, files: { [`${prefix}zerovity.factory.yaml`]: files['zerovity.factory.yaml'] } });
      const pr = await forge.openPullRequest({ owner: repo.owner, name: repo.name, head: branch, base: repo.branch, title: message, body: 'Proposed from the Zerovity Connections screen. The `zerovity/factory-config` check validates it.', draft: false });
      return { applied: false, pr: { url: pr.url } };
    }
    const r = await this.s.defs.apply(factoryId, files, { message, by });
    return { applied: r.applied, commit: r.commit, issues: r.issues.filter((i) => i.severity !== 'info') };
  }
}

/* ===========================================================================================================
 * Forge resolver, tracker resolver, notifier
 * ========================================================================================================= */

export class DbForgeResolver implements ForgeResolver {
  private conns: ConnectionService;
  constructor(s: Pick<Services, 'db' | 'secrets'> & { defs?: Services['defs']; conns?: ConnectionService }, o: { fetchImpl?: typeof fetch } = {}) {
    this.conns = s.conns ?? new ConnectionService({ db: s.db, secrets: s.secrets, defs: s.defs as Services['defs'] }, o);
    this.db = s.db;
  }
  private db: Db;
  async forRepo(factoryId: string, repo: { forge: string; owner: string; name: string; installId?: string | null }): Promise<Forge | undefined> {
    if (repo.forge !== 'github') return undefined;
    const [f] = await this.db.select().from(t.factories).where(eq(t.factories.id, factoryId));
    if (!f) return undefined;
    const mapped = await this.db.select({ c: t.connections }).from(t.factoryConnections).innerJoin(t.connections, eq(t.factoryConnections.connectionId, t.connections.id)).where(and(eq(t.factoryConnections.factoryId, factoryId), eq(t.connections.type, 'forge')));
    const c = mapped[0]?.c ?? (await this.conns.firstOfType(f.orgId, 'forge'));
    if (!c) return undefined;
    return this.conns.githubForge(c, repo.installId ?? undefined);
  }
}

export class TrackerResolver {
  constructor(private conns: ConnectionService, private db: Db) {}
  async forFactory(factoryId: string, connectionName?: string): Promise<{ client: TrackerClient; connection: ConnectionRow } | undefined> {
    const [f] = await this.db.select().from(t.factories).where(eq(t.factories.id, factoryId));
    if (!f) return undefined;
    const c = connectionName ? await this.conns.byName(f.orgId, connectionName) : await this.conns.firstOfType(f.orgId, 'tracker');
    return c ? { client: await this.conns.jiraClient(c), connection: c } : undefined;
  }
}

/** Foreman updates in the source thread: GitHub issue comments and Jira comments, Jira status mapping and PR remote link. */
export class SourceNotifier implements Notifier {
  private linked = new Set<string>();
  constructor(private s: Pick<Services, 'db' | 'defs'>, private forges: ForgeResolver, private trackers: TrackerResolver, private log: Logger = nullLogger) {}
  async send(m: SourceMessage): Promise<void> {
    const w = m.workItem;
    if (w.sourceType === 'github' && w.sourceRef) {
      const x = /^([^/]+)\/([^#]+)#(\d+)$/.exec(w.sourceRef);
      if (!x) return;
      const forge = await this.forges.forRepo(w.factoryId, { forge: 'github', owner: x[1], name: x[2] });
      if (forge) await forge.commentOnIssue(x[1], x[2], Number(x[3]), `${m.text}\n\n<sub>Zerovity Factory · ${w.shortId}</sub>`);
    } else if (w.sourceType === 'jira' && w.sourceRef) {
      const active = await this.s.defs.getActive(w.factoryId);
      const jc = active?.definition.factory.integrations?.jira.find((j) => w.sourceRef!.startsWith(j.project + '-')) ?? active?.definition.factory.integrations?.jira[0];
      const t0 = await this.trackers.forFactory(w.factoryId, jc?.connection);
      if (!t0) return;
      await t0.client.addComment(w.sourceRef, `${m.text}\n\n— Zerovity Factory (${w.shortId})`);
      if (w.prUrl && !this.linked.has(w.id + w.prUrl)) { await t0.client.addRemoteLink(w.sourceRef, { url: w.prUrl, title: `${w.shortId} pull request` }).catch((e) => this.log.warn('remote link failed', { error: errMessage(e) })); this.linked.add(w.id + w.prUrl); }
      const target = jc?.statusMap?.[w.state];
      if (target) await t0.client.transition(w.sourceRef, target).catch((e) => this.log.warn('jira transition failed', { error: errMessage(e) }));
    }
  }
}

/* ===========================================================================================================
 * Intake from forges, trackers, webhooks and schedules
 * ========================================================================================================= */

export interface IntakeResult { handled: string; workItemId?: string; factoryId?: string }

export class IntakeService {
  constructor(private s: Pick<Services, 'db' | 'orch' | 'defs' | 'contexts'>, private o: { log?: Logger; forges?: ForgeResolver; trackers?: TrackerResolver } = {}) {}
  private get db() { return this.s.db; }

  /** orgId limits the match to one organisation: an event proven (by its signature) to belong to org A must never reach org B's factories. */
  private async factoriesForRepo(slug: string, orgId?: string) {
    const [owner, name = ''] = slug.split('/');
    const rows = await this.db.select({ f: t.factories, r: t.repositories }).from(t.repositories).innerJoin(t.factories, eq(t.repositories.factoryId, t.factories.id)).where(and(sql`lower(${t.repositories.owner}) = ${owner.toLowerCase()}`, sql`lower(${t.repositories.name}) = ${name.toLowerCase()}`, eq(t.factories.status, 'active'), ...(orgId ? [eq(t.factories.orgId, orgId)] : [])));
    return rows;
  }

  private async existing(factoryId: string, type: string, ref: string) {
    return (await this.db.select().from(t.workItems).where(and(eq(t.workItems.factoryId, factoryId), eq(t.workItems.sourceType, type), eq(t.workItems.sourceRef, ref), sql`${t.workItems.state} not in ('COMPLETE','CANCELLED','FAILED')`)).orderBy(desc(t.workItems.createdAt)).limit(1))[0];
  }

  async onForgeEvent(ev: ForgeEvent, scope?: { orgId: string }): Promise<IntakeResult[]> {
    if (ev.type === 'ignored') return [{ handled: `ignored: ${ev.reason}` }];
    if (ev.type === 'config_pr') return [{ handled: 'config_pr' }];
    const out: IntakeResult[] = [];
    for (const { f, r } of await this.factoriesForRepo(ev.repo, scope?.orgId)) {
      const active = await this.s.defs.getActive(f.id);
      if (!active) continue;
      const alias = active.definition.factory.alias ?? f.alias;
      const base = active.definition.factory.integrations?.github?.triggerLabel ?? 'zerovity';
      const autos = Object.values(active.definition.automations).filter((a) => a.fm.enabled && a.fm.triggers.some((tr) => tr.provider === 'github'));
      const triggers = (event: string) => autos.flatMap((a) => a.fm.triggers.filter((tr) => tr.provider === 'github' && tr.event === event).map((tr) => ({ a, tr })));
      const startFor = (agent: string): 'auto' | 'INTENT' | 'SPEC' | 'BUILD' => { const ph = active.agents.get(agent)?.fm.phase; return ph === 'INTENT' || ph === 'SPEC' || ph === 'BUILD' ? ph : 'auto'; };
      const repoOk = (tr: { filter?: { repos?: string[] } }) => !tr.filter?.repos?.length || tr.filter.repos.some((x) => x.toLowerCase() === ev.repo.toLowerCase());

      const create = async (issue: { number: number; title: string; body: string; url: string; author: string; labels?: string[] }, why: string, auto?: { a: { fm: { agent: string }; body: string } }): Promise<IntakeResult> => {
        const ref = `${ev.repo}#${issue.number}`;
        const ex = await this.existing(f.id, 'github', ref);
        if (ex) return { handled: `${why}: already tracked as ${ex.shortId}`, workItemId: ex.id, factoryId: f.id };
        const wi = await this.s.orch.createWorkItem({ factoryId: f.id, title: issue.title, body: issue.body + (auto?.a.body.trim() ? `\n\n---\nAutomation instructions:\n${auto.a.body.trim()}` : ''), source: { type: 'github', ref, url: issue.url }, requesterName: issue.author, repoId: r.id, startPhase: auto ? startFor(auto.a.fm.agent) : 'auto', actor: `github:${issue.author}`, context: [{ layer: 'workItem', scopeId: '', title: `GitHub issue ${ref}`, kind: 'ticket', body: `# ${issue.title}\n\n${issue.body}\n\nLabels: ${(issue.labels ?? []).join(', ')}\nURL: ${issue.url}`, priority: 'always', tags: ['github'] }] });
        return { handled: `${why}: created ${wi.shortId}`, workItemId: wi.id, factoryId: f.id };
      };

      if (ev.type === 'issue_labeled') {
        const hit = triggers('issue_labeled').find(({ tr }) => repoOk(tr as never) && ((tr as { filter?: { labels?: string[] } }).filter?.labels?.map((l) => l.toLowerCase()).includes(ev.label.toLowerCase())));
        if (hit) out.push(await create(ev.issue, 'label (automation)', hit));
        else if (!autos.length && matchLabel(ev.label, alias, base)) out.push(await create(ev.issue, 'label'));
        else out.push({ handled: 'label did not match this factory', factoryId: f.id });
      } else if (ev.type === 'issue_mentioned' || ev.type === 'issue_commented') {
        const ref = `${ev.repo}#${ev.issue.number}`;
        const ex = await this.existing(f.id, 'github', ref);
        if (ev.comment.isBot) { out.push({ handled: 'ignored bot comment' }); continue; }
        if (ex) { await this.s.orch.ingestMessage(ex.id, { body: ev.comment.body, authorName: ev.comment.author, authorId: `github:${ev.comment.author}`, channel: 'github', externalRef: `gh-comment:${ev.comment.id}` }); out.push({ handled: 'routed comment to the work item', workItemId: ex.id, factoryId: f.id }); }
        else if (ev.type === 'issue_mentioned' && matchMention(ev.comment.body, alias)) out.push(await create(ev.issue, 'mention'));
        else out.push({ handled: 'comment on untracked issue' });
      } else if (ev.type === 'pull_request_commented') {
        const [w] = await this.db.select().from(t.workItems).where(and(eq(t.workItems.factoryId, f.id), eq(t.workItems.prNumber, ev.pr.number)));
        if (w && !ev.comment.isBot) { await this.s.orch.ingestMessage(w.id, { body: ev.comment.body, authorName: ev.comment.author, authorId: `github:${ev.comment.author}`, channel: 'github', externalRef: `gh-comment:${ev.comment.id}` }); out.push({ handled: 'routed PR comment', workItemId: w.id, factoryId: f.id }); }
      } else if (ev.type === 'pull_request_closed') {
        const [w] = await this.db.select().from(t.workItems).where(and(eq(t.workItems.factoryId, f.id), eq(t.workItems.prNumber, ev.pr.number)));
        if (w && ['AWAITING_HANDOFF', 'AWAITING_SPEC_APPROVAL'].includes(w.state)) {
          if (w.state === 'AWAITING_HANDOFF') await this.s.orch.prClosed(w.id, ev.pr.merged);
          else await this.s.orch.cancelWorkItem(w.id, 'github:pr-closed');
          out.push({ handled: ev.pr.merged ? 'PR merged' : 'PR closed', workItemId: w.id, factoryId: f.id });
        }
      } else if (ev.type === 'pull_request_pushed') {
        const [w] = await this.db.select().from(t.workItems).where(and(eq(t.workItems.factoryId, f.id), eq(t.workItems.branch, ev.pr.headRef)));
        if (w && ev.authors.some((a) => a && !/\[bot\]$/.test(a) && a !== 'zerovity')) { await this.db.update(t.workItems).set({ flags: { ...(w.flags as object), humanCommits: true } }).where(eq(t.workItems.id, w.id)); out.push({ handled: 'human push recorded', workItemId: w.id }); }
      }
    }
    return out.length ? out : [{ handled: 'no factory maps this repository' }];
  }

  async onTrackerEvent(ev: TrackerEvent): Promise<IntakeResult[]> {
    if (ev.type === 'ignored') return [{ handled: `ignored: ${ev.reason}` }];
    const out: IntakeResult[] = [];
    const facs = await this.db.select().from(t.factories).where(eq(t.factories.status, 'active'));
    for (const f of facs) {
      const active = await this.s.defs.getActive(f.id);
      const maps = active?.definition.factory.integrations?.jira ?? [];
      const project = ev.type === 'comment_created' ? ev.project : ev.issue.project;
      const m = maps.find((x) => x.project === project);
      if (!active || !m) continue;
      const alias = active.definition.factory.alias ?? f.alias;
      const key = ev.type === 'comment_created' ? ev.key : ev.issue.key;
      const ex = await this.existing(f.id, 'jira', key);
      if (ev.type === 'comment_created') {
        if (ev.comment.isBot) continue;
        if (ex) { await this.s.orch.ingestMessage(ex.id, { body: ev.comment.body, authorName: ev.comment.author, authorId: `jira:${ev.comment.author}`, channel: 'jira', externalRef: `jira-comment:${ev.comment.id}` }); out.push({ handled: 'routed Jira comment', workItemId: ex.id, factoryId: f.id }); continue; }
        if (!matchMention(ev.comment.body, alias)) continue;
        const client = await this.o.trackers?.forFactory(f.id, m.connection);
        const issue = client ? await client.client.getIssue(ev.key) : undefined;
        if (issue) out.push(await this.createFromJira(f.id, issue, 'mention'));
        continue;
      }
      const wants = ev.type === 'issue_labeled' ? ev.added.map((l) => l.toLowerCase()).includes(m.label.toLowerCase()) : ev.issue.labels.map((l) => l.toLowerCase()).includes(m.label.toLowerCase());
      if (!wants) { out.push({ handled: 'issue does not carry the intake label', factoryId: f.id }); continue; }
      if (ex) { out.push({ handled: `already tracked as ${ex.shortId}`, workItemId: ex.id }); continue; }
      out.push(await this.createFromJira(f.id, ev.issue, ev.type));
    }
    return out.length ? out : [{ handled: 'no factory maps this Jira project' }];
  }

  private async createFromJira(factoryId: string, i: { key: string; summary: string; description: string; labels: string[]; url: string; reporter: string }, why: string): Promise<IntakeResult> {
    const wi = await this.s.orch.createWorkItem({ factoryId, title: i.summary, body: i.description, source: { type: 'jira', ref: i.key, url: i.url }, requesterName: i.reporter, actor: `jira:${i.reporter}`, context: [{ layer: 'workItem', scopeId: '', title: `Jira ${i.key}`, kind: 'ticket', body: `# ${i.key}: ${i.summary}\n\n${i.description}\n\nLabels: ${i.labels.join(', ')}\nURL: ${i.url}`, tags: ['jira'] }] });
    return { handled: `${why}: created ${wi.shortId}`, workItemId: wi.id, factoryId };
  }

  /** Inbound authenticated webhook automations (provider: webhook). */
  async onWebhook(factoryId: string, name: string, payload: { title?: string; body?: string; ref?: string }): Promise<IntakeResult> {
    const active = await this.s.defs.getActive(factoryId);
    const auto = Object.values(active?.definition.automations ?? {}).find((a) => a.fm.enabled && a.fm.triggers.some((tr) => tr.provider === 'webhook' && (!tr.name || tr.name === name)));
    if (!auto) return { handled: 'no webhook automation matches', factoryId };
    if (!payload.title) throw invalid('title is required');
    const ph = active!.agents.get(auto.fm.agent)?.fm.phase;
    const wi = await this.s.orch.createWorkItem({ factoryId, title: payload.title, body: `${payload.body ?? ''}${auto.body.trim() ? `\n\n---\nAutomation instructions:\n${auto.body.trim()}` : ''}`, source: { type: 'webhook', ref: payload.ref ?? undefined }, startPhase: ph === 'INTENT' || ph === 'SPEC' || ph === 'BUILD' ? ph : 'auto', actor: `webhook:${name}` });
    return { handled: `created ${wi.shortId}`, workItemId: wi.id, factoryId };
  }

  /** Fire schedule automations whose cron matches this minute; deduplicated per minute. */
  async tickSchedules(now = new Date()): Promise<number> {
    let n = 0;
    const facs = await this.db.select().from(t.factories).where(eq(t.factories.status, 'active'));
    for (const f of facs) {
      const active = await this.s.defs.getActive(f.id);
      for (const a of Object.values(active?.definition.automations ?? {})) {
        if (!a.fm.enabled) continue;
        for (const tr of a.fm.triggers) {
          if (tr.provider !== 'schedule' || !cronMatches(tr.cron, now)) continue;
          const ref = `schedule:${tr.name ?? a.name}:${now.toISOString().slice(0, 16)}`;
          if (await this.existing(f.id, 'schedule', ref)) continue;
          const ph = active!.agents.get(a.fm.agent)?.fm.phase;
          await this.s.orch.createWorkItem({ factoryId: f.id, title: `Scheduled: ${tr.name ?? a.name}`, body: a.body.trim(), source: { type: 'schedule', ref }, startPhase: ph === 'INTENT' || ph === 'SPEC' || ph === 'BUILD' ? ph : 'auto', actor: 'schedule' });
          n++;
        }
      }
    }
    return n;
  }

  /** `factory` provider: a work item changed phase and an automation asked to react. */
  async onPhaseChanged(workItemId: string, toState: string): Promise<number> {
    const [w] = await this.db.select().from(t.workItems).where(eq(t.workItems.id, workItemId));
    if (!w || w.sourceType === 'factory') return 0;
    const active = await this.s.defs.getActive(w.factoryId);
    let n = 0;
    for (const a of Object.values(active?.definition.automations ?? {})) {
      if (!a.fm.enabled) continue;
      for (const tr of a.fm.triggers) if (tr.provider === 'factory' && (!tr.filter?.phase || tr.filter.phase === toState)) {
        await this.s.orch.createWorkItem({ factoryId: w.factoryId, title: `${a.name}: ${w.shortId} reached ${toState}`, body: `${a.body.trim()}\n\nRelated work item: ${w.shortId} ${w.title}`, source: { type: 'factory', ref: `${w.id}:${toState}:${a.name}` }, actor: 'automation' });
        n++;
      }
    }
    return n;
  }
}

/* ===========================================================================================================
 * Git-backed definitions
 * ========================================================================================================= */

/** Pull a Git-backed factory's definition from its repository and apply it (spec 6). */
export async function syncDefinitionFromGit(s: Pick<Services, 'db' | 'defs'>, forges: ForgeResolver, factoryId: string, by = 'git-sync') {
  const [f] = await s.db.select().from(t.factories).where(eq(t.factories.id, factoryId));
  if (!f?.definitionRepo) throw invalid('Factory is not Git-backed');
  const r = f.definitionRepo;
  const forge = await forges.forRepo(factoryId, { forge: r.forge, owner: r.owner, name: r.name });
  if (!forge?.readTree) throw invalid('No connection can read the definition repository');
  const files = await forge.readTree(r.owner, r.name, r.branch, r.path);
  return s.defs.apply(factoryId, files, { message: `Sync from ${r.owner}/${r.name}@${r.branch}`, by });
}

/** The `zerovity/factory-config` check run for PRs against a definition repo. */
export async function checkDefinitionPr(s: Pick<Services, 'packs'>, forge: Forge, o: { owner: string; name: string; headSha: string; path?: string }): Promise<{ ok: boolean; errors: number }> {
  if (!forge.readTree || !forge.createCheckRun) return { ok: true, errors: 0 };
  await forge.createCheckRun({ owner: o.owner, name: o.name, headSha: o.headSha, checkName: 'zerovity/factory-config', status: 'in_progress', title: 'Validating factory definition', summary: 'Running zf validate' });
  const files = await forge.readTree(o.owner, o.name, o.headSha, o.path ?? '');
  const v = await validateFactory(files, s.packs);
  const errors = v.issues.filter((i) => i.severity === 'error');
  const prefix = o.path ? o.path.replace(/\/?$/, '/') : '';
  await forge.createCheckRun({
    owner: o.owner, name: o.name, headSha: o.headSha, checkName: 'zerovity/factory-config', status: 'completed', conclusion: errors.length ? 'failure' : 'success', title: errors.length ? `${errors.length} problem(s) in the factory definition` : 'Factory definition is valid',
    summary: errors.length ? errors.slice(0, 20).map((e) => `- \`${e.file}${e.line ? `:${e.line}` : ''}\` ${e.message}`).join('\n') : `${Object.keys(v.agentSkills).length} agents resolved, ${v.skillReports.length} skills linted.`,
    annotations: errors.filter((e) => e.line).slice(0, 50).map((e) => ({ path: prefix + e.file, line: e.line!, message: e.message, level: 'failure' as const })),
  });
  return { ok: !errors.length, errors: errors.length };
}

export { inArray };

import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { tables as t } from '@zerovity/db';
import { forbidden, notFound, invalid, type Role, roleAtLeast, errMessage } from '@zerovity/core';
import { listWorkItems, workItemDetail, type Services } from '@zerovity/orchestrator';
import { jsonSchemaFor, DOC_SCHEMAS, type DocName, type Files } from '@zerovity/definition';
import { validateFactory } from '@zerovity/skills';

export interface McpUser { id: string; orgId: string; name: string; groups: string[]; roleFor(factoryId: string): Role }
export interface McpDeps { s: Services; publicUrl: string }

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: errMessage(e) }] });

/** Build an MCP server bound to one authenticated caller (spec 11.4). Tools respect the caller's roles in each factory. */
export function createMcpServer(d: McpDeps, u: McpUser): McpServer {
  const { s } = d;
  const db = s.db;
  const server = new McpServer({ name: 'zerovity-factory', version: '0.1.0' });

  const factoryOf = async (id: string, role: Role = 'viewer') => {
    const [f] = await db.select().from(t.factories).where(eq(t.factories.id, id));
    if (!f || f.orgId !== u.orgId) throw notFound('Factory', id);
    if (!roleAtLeast(u.roleFor(f.id), role)) throw forbidden(`Requires the ${role} role in ${f.name}`);
    return f;
  };
  const taskOf = async (idOrShort: string, role: Role = 'viewer') => {
    const [w] = await db.select().from(t.workItems).where(or(eq(t.workItems.id, idOrShort), eq(t.workItems.shortId, idOrShort.toUpperCase())));
    if (!w) throw notFound('Task', idOrShort);
    const f = await factoryOf(w.factoryId, role);
    return { w, f };
  };
  const guard = <A, R>(fn: (a: A) => Promise<R>) => async (a: A) => { try { return text(await fn(a)); } catch (e) { return fail(e); } };
  const brief = (w: typeof t.workItems.$inferSelect) => ({ id: w.id, shortId: w.shortId, title: w.title, state: w.state, phase: w.phase, branch: w.branch, prUrl: w.prUrl, costUsd: Number(w.costUsd.toFixed(2)), createdAt: w.createdAt });

  server.registerTool('list_factories', { title: 'List factories', description: 'Factories the caller can access, with their repositories and aliases.', inputSchema: {} }, guard(async () => {
    const fs = await db.select().from(t.factories).where(eq(t.factories.orgId, u.orgId));
    const out = [];
    for (const f of fs) { if (!roleAtLeast(u.roleFor(f.id), 'viewer')) continue; const repos = await db.select().from(t.repositories).where(eq(t.repositories.factoryId, f.id)); out.push({ id: f.id, name: f.name, alias: f.alias, paused: f.paused, repositories: repos.map((r) => `${r.owner}/${r.name}`) }); }
    return out;
  }));

  server.registerTool('send_task', { title: 'Send a task to the factory', description: 'Create a work item, or hand work back to an existing one (pass taskId with a branch / PR reference and a note).', inputSchema: { factoryId: z.string().optional(), taskId: z.string().optional(), title: z.string().optional(), description: z.string().optional(), repo: z.string().optional().describe('owner/name'), branch: z.string().optional(), prUrl: z.string().optional(), note: z.string().optional(), startPhase: z.enum(['auto', 'INTENT', 'SPEC', 'BUILD']).optional() } }, guard(async (a) => {
    if (a.taskId) {
      const { w, f } = await taskOf(a.taskId, 'member');
      if (a.branch || a.prUrl) await db.update(t.workItems).set({ branch: a.branch ?? w.branch, prUrl: a.prUrl ?? w.prUrl, updatedAt: new Date() }).where(eq(t.workItems.id, w.id));
      await s.orch.ingestMessage(w.id, { body: `Handed back from ${u.name}'s local agent${a.branch ? ` on branch ${a.branch}` : ''}${a.prUrl ? ` (${a.prUrl})` : ''}.${a.note ? `\n\n${a.note}` : ''}`, authorName: u.name, authorId: u.id, channel: 'mcp' });
      s.orch.audit(f.id, u.id, 'mcp.handback', w.shortId, { branch: a.branch, prUrl: a.prUrl }).catch(() => undefined);
      return { ...brief((await db.select().from(t.workItems).where(eq(t.workItems.id, w.id)))[0]), handedBack: true };
    }
    if (!a.title) throw invalid('title is required to create a task');
    const factoryId = a.factoryId ?? (await db.select().from(t.factories).where(eq(t.factories.orgId, u.orgId)))[0]?.id;
    if (!factoryId) throw notFound('Factory');
    const f = await factoryOf(factoryId, 'member');
    let repoId: string | undefined;
    if (a.repo) { const [o, n] = a.repo.split('/'); repoId = (await db.select().from(t.repositories).where(and(eq(t.repositories.factoryId, f.id), eq(t.repositories.owner, o), eq(t.repositories.name, n))))[0]?.id; if (!repoId) throw notFound('Repository', a.repo); }
    const wi = await s.orch.createWorkItem({ factoryId: f.id, title: a.title, body: a.description ?? '', repoId, startPhase: a.startPhase ?? 'auto', requesterId: u.id, requesterName: u.name, actor: u.id, source: { type: 'mcp' } });
    return brief(wi);
  }));

  server.registerTool('list_tasks', { title: 'List tasks', description: 'Work items of a factory, newest first.', inputSchema: { factoryId: z.string(), state: z.string().optional().describe('comma separated states'), limit: z.number().int().min(1).max(100).optional() } }, guard(async (a) => {
    await factoryOf(a.factoryId);
    return (await listWorkItems(db, { factoryId: a.factoryId, state: a.state?.split(','), limit: a.limit ?? 25 })).map(brief);
  }));

  server.registerTool('search_tasks', { title: 'Search tasks', description: 'Full-text search over titles, short ids and descriptions across your factories.', inputSchema: { query: z.string().min(1), factoryId: z.string().optional() } }, guard(async (a) => {
    const fs = a.factoryId ? [await factoryOf(a.factoryId)] : (await db.select().from(t.factories).where(eq(t.factories.orgId, u.orgId))).filter((f) => roleAtLeast(u.roleFor(f.id), 'viewer'));
    const out = [];
    for (const f of fs) out.push(...(await listWorkItems(db, { factoryId: f.id, q: a.query, limit: 20 })).map(brief));
    return out;
  }));

  server.registerTool('get_task', { title: 'Get a task', description: 'Status, spec, conversation tail and pull request. With start_working=true it also returns the branch, the commands to set up a local worktree, and the assembled context for the executor.', inputSchema: { taskId: z.string(), start_working: z.boolean().optional() } }, guard(async (a) => {
    const { w, f } = await taskOf(a.taskId, a.start_working ? 'member' : 'viewer');
    const detail = await workItemDetail(db, s.defs, w.id);
    const [repo] = w.repoId ? await db.select().from(t.repositories).where(eq(t.repositories.id, w.repoId)) : [];
    const base = { ...brief(w), body: w.body, factory: f.name, repository: repo ? `${repo.owner}/${repo.name}` : null, defaultBranch: repo?.defaultBranch ?? null, spec: (await s.orch.specText(w.id)) ?? null, pendingGate: detail.pendingGate?.type ?? null, questions: detail.questions.filter((q) => q.answer === null).map((q) => q.text), recentMessages: detail.messages.slice(-8).map((m) => ({ from: m.authorName ?? m.authorKind, at: m.createdAt, text: m.body })) };
    if (!a.start_working) return base;
    const active = await s.defs.getActive(f.id);
    const ag = active ? s.defs.agentForPhase(active, 'BUILD') : undefined;
    const ctx = ag ? await s.contexts.preview(w.id, { name: ag.name, phase: 'BUILD', contextScopes: ag.fm.contextScopes }) : undefined;
    const branch = w.branch ?? `zerovity/${w.shortId.toLowerCase()}`;
    s.orch.audit(f.id, u.id, 'mcp.start_working', w.shortId, { branch }).catch(() => undefined);
    return { ...base, branch, worktreeSetup: repo ? [`git clone https://github.com/${repo.owner}/${repo.name}.git  # if you do not have it yet`, `git fetch origin`, `git checkout ${branch} || git checkout -b ${branch} origin/${repo.defaultBranch}`] : [`git checkout -b ${branch}`], context: ctx ? { tokens: ctx.tokens, markdown: ctx.contextMd, items: ctx.items } : null, rules: ['Commit on the branch; do not merge.', 'When finished call send_task with taskId, branch and a note, then complete_task.'] };
  }));

  server.registerTool('get_conversation', { title: 'Get the conversation', description: 'The foreman thread of a task: requester messages, foreman updates, agent summaries.', inputSchema: { taskId: z.string(), limit: z.number().int().min(1).max(200).optional() } }, guard(async (a) => {
    const { w } = await taskOf(a.taskId);
    const rows = await db.select().from(t.messages).where(eq(t.messages.workItemId, w.id)).orderBy(desc(t.messages.createdAt)).limit(a.limit ?? 50);
    return rows.reverse().map((m) => ({ from: m.authorName ?? m.authorKind, kind: m.authorKind, channel: m.channel, at: m.createdAt, text: m.body }));
  }));

  server.registerTool('message_foreman', { title: 'Message the foreman', description: 'Post to the task thread. If an agent is waiting on a question, the message answers it.', inputSchema: { taskId: z.string(), message: z.string().min(1) } }, guard(async (a) => {
    const { w } = await taskOf(a.taskId, 'member');
    return s.orch.ingestMessage(w.id, { body: a.message, authorName: u.name, authorId: u.id, channel: 'mcp' });
  }));

  server.registerTool('add_context', { title: 'Add context', description: 'Attach a note, a URL snapshot or a file (base64) to a task or to the factory.', inputSchema: { taskId: z.string().optional(), factoryId: z.string().optional(), title: z.string().min(1), content: z.string().optional(), url: z.string().url().optional(), fileName: z.string().optional(), fileBase64: z.string().optional(), priority: z.enum(['always', 'relevant', 'on_request']).optional() } }, guard(async (a) => {
    let layer: 'workItem' | 'factory', scopeId: string, factoryId: string;
    if (a.taskId) { const { w, f } = await taskOf(a.taskId, 'member'); layer = 'workItem'; scopeId = w.id; factoryId = f.id; }
    else if (a.factoryId) { const f = await factoryOf(a.factoryId, 'factory_owner'); layer = 'factory'; scopeId = f.id; factoryId = f.id; }
    else throw invalid('taskId or factoryId is required');
    const f = await factoryOf(factoryId);
    const item = a.url ? await s.contexts.attachUrl(f.orgId, { layer, scopeId, url: a.url, title: a.title, priority: a.priority, factoryId }, u.id)
      : a.fileBase64 ? await s.contexts.attachFile(f.orgId, { layer, scopeId, name: a.fileName ?? a.title, data: Buffer.from(a.fileBase64, 'base64'), title: a.title, priority: a.priority, factoryId }, u.id)
      : await s.contexts.create(f.orgId, { layer, scopeId, title: a.title, body: a.content ?? '', kind: 'note', priority: a.priority ?? 'always' }, u.id, factoryId);
    return { id: item.id, title: item.title, layer: item.layer, tokens: item.tokenCount };
  }));

  server.registerTool('get_agent_context', { title: 'Get agent context', description: 'What a given agent would see for a task: the assembled CONTEXT.md with per-item token counts.', inputSchema: { taskId: z.string(), agent: z.string().optional(), phase: z.string().optional() } }, guard(async (a) => {
    const { w, f } = await taskOf(a.taskId);
    const active = await s.defs.getActive(f.id);
    const ag = (a.agent ? active?.agents.get(a.agent) : active && s.defs.agentForPhase(active, a.phase ?? w.phase ?? 'INTENT')) ?? [...(active?.agents.values() ?? [])][0];
    if (!ag) throw notFound('Agent');
    const b = await s.contexts.preview(w.id, { name: ag.name, phase: a.phase ?? ag.fm.phase, contextScopes: ag.fm.contextScopes, tokenBudget: ag.fm.contextTokenBudget });
    return { agent: ag.name, tokens: b.tokens, budget: b.budget, trimmed: b.trimmed, items: b.report.map((r) => ({ id: r.id, title: r.title, layer: r.layer, tokens: r.tokens, form: r.form, reason: r.reason })), markdown: b.contextMd };
  }));

  server.registerTool('validate_definition', { title: 'Validate a definition', description: 'Validate a factory definition (a map of path to content merged over the current one). Returns issues with file and line.', inputSchema: { factoryId: z.string(), files: z.record(z.string(), z.string()).optional() } }, guard(async (a) => {
    const f = await factoryOf(a.factoryId);
    const cur = (await s.defs.getVersion(f.id, f.definitionCommit ?? undefined))?.files ?? {};
    const files: Files = { ...cur, ...(a.files ?? {}) };
    const v = await validateFactory(files, s.packs);
    return { ok: v.ok, issues: v.issues };
  }));

  server.registerTool('get_schema', { title: 'Get a JSON Schema', description: `JSON Schema for a definition file type: ${Object.keys(DOC_SCHEMAS).join(', ')}.`, inputSchema: { doc: z.enum(Object.keys(DOC_SCHEMAS) as [DocName, ...DocName[]]) } }, guard(async (a) => jsonSchemaFor(a.doc)));

  server.registerTool('complete_task', { title: 'Complete a task', description: 'Close out a task that is awaiting handoff.', inputSchema: { taskId: z.string(), note: z.string().optional() } }, guard(async (a) => {
    const { w } = await taskOf(a.taskId, 'member');
    if (a.note) await s.orch.ingestMessage(w.id, { body: a.note, authorName: u.name, authorId: u.id, channel: 'mcp' });
    if (w.state !== 'AWAITING_HANDOFF') return { completed: false, state: w.state, reason: 'Only tasks awaiting handoff can be completed; the factory is still working on this one.' };
    await s.orch.markHandedOff(w.id, u.id);
    return { completed: true, shortId: w.shortId };
  }));

  void sql;
  return server;
}

/** Handle one streamable-HTTP request statelessly: a fresh server and transport per request. */
export async function handleMcpRequest(d: McpDeps, u: McpUser, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const server = createMcpServer(d, u);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

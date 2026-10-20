import { spawnSync } from 'node:child_process';
import { estimateTokens, type NormalisedEvent } from '@zerovity/core';
import { cleanPrompt, detectCli, firstSession, relPath, safeJson, str, sumUsage, type CommandSpec, type HarnessAdapter, type RunSpec } from '@zerovity/harness-common';

/**
 * The Cursor CLI installs as `agent` (older installs: `cursor-agent`). ZF_CURSOR_BIN overrides both. ZF_CURSOR_ARGS (a JSON array)
 * is put in front of the arguments, which lets the CLI be reached through a wrapper, for example on Windows through WSL:
 * ZF_CURSOR_BIN=wsl ZF_CURSOR_ARGS='["agent"]'.
 */
export const CURSOR_BINARIES = ['agent', 'cursor-agent'] as const;
export const CURSOR_MCP_PATH = '.cursor/mcp.json';
export const CURSOR_CLI_CONFIG_PATH = '.cursor/cli.json';

/**
 * Project permissions for headless runs. `--force` lets the agent run commands without asking, so the deny list
 * keeps it away from publishing and secrets (the sandbox and credential isolation remain the real boundary).
 * Syntax: Shell(commandBase) / Shell(command:args), Read(glob), Write(glob); deny wins over allow.
 */
export const CURSOR_DENY = ['Shell(gh)', 'Shell(git:push*)', 'Shell(git:remote*)', 'Read(.env*)', 'Read(**/*.pem)', 'Write(.env*)', 'Write(**/*.pem)', 'Write(**/*.key)', 'Write(.git/**)'];

export function cursorArgsPrefix(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!env.ZF_CURSOR_ARGS) return [];
  try { const a = JSON.parse(env.ZF_CURSOR_ARGS); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

export function buildCursorConfig(): string {
  return JSON.stringify({ permissions: { allow: [], deny: CURSOR_DENY } }, null, 2);
}

export function buildCursorMcp(spec: RunSpec): string | undefined {
  const entries = Object.entries(spec.mcpServers ?? {});
  if (!entries.length) return undefined;
  const mcp: Record<string, unknown> = {};
  for (const [n, s] of entries) mcp[n] = s.url ? { url: s.url, headers: s.headers ?? {} } : { command: s.command, args: s.args ?? [], env: s.env ?? {} };
  return JSON.stringify({ mcpServers: mcp }, null, 2);
}

/** `readToolCall` -> `read`, `shellToolCall` -> `shell`; the generic form carries the tool name in `function.name`. */
export function cursorToolName(call: Record<string, unknown>): { name: string; body: Record<string, unknown> } {
  const key = Object.keys(call).find((k) => k !== 'function') ?? 'function';
  const body = (call[key] ?? {}) as Record<string, unknown>;
  if (key === 'function') return { name: str((body as { name?: unknown }).name, 60) || 'tool', body };
  return { name: key.replace(/ToolCall$/, '').replace(/^./, (c) => c.toLowerCase()), body };
}

const EDIT_TOOLS = new Set(['edit', 'strReplace', 'str_replace', 'applyPatch', 'apply_patch', 'multiEdit', 'search_replace', 'searchReplace']);

export class CursorAdapter implements HarnessAdapter {
  type = 'cursor' as const;
  private bin: string = process.env.ZF_CURSOR_BIN || CURSOR_BINARIES[0];
  private prefix: string[] = cursorArgsPrefix();
  private open = new Map<string, { name: string; args: Record<string, unknown> }>();
  private promptTokens = 0;
  private outTokens = 0;
  private resultTokens = 0;

  /** Cursor's own version looks like 2025.09.18-abc123; for any other `agent` binary require "cursor" in its help text. */
  private isCursor(bin: string, version?: string): boolean {
    if (version && /^\d{4}\.\d{1,2}\.\d{1,2}/.test(version)) return true;
    try {
      const r = spawnSync(bin, [...this.prefix, '--help'], { encoding: 'utf8', timeout: 8000 });
      return /cursor/i.test(`${r.stdout} ${r.stderr}`);
    } catch { return false; }
  }

  async detect() {
    const candidates = process.env.ZF_CURSOR_BIN ? [process.env.ZF_CURSOR_BIN] : [...CURSOR_BINARIES];
    for (const b of candidates) {
      const d = detectCli(b, [...this.prefix, '--version']);
      if (d.installed && this.isCursor(b, d.version)) { this.bin = b; return d; }
    }
    return { installed: false };
  }

  buildCommand(spec: RunSpec): CommandSpec {
    const args = ['-p', cleanPrompt(spec.prompt), '--output-format', 'stream-json', '--force', '--trust'];
    if (spec.mcpServers && Object.keys(spec.mcpServers).length) args.push('--approve-mcps');
    if (spec.agent.harness.model) args.push('--model', spec.agent.harness.model);
    if (spec.resumeSessionId) args.push('--resume', spec.resumeSessionId);
    const files: Record<string, string> = { [CURSOR_CLI_CONFIG_PATH]: buildCursorConfig() };
    const mcp = buildCursorMcp(spec);
    if (mcp) files[CURSOR_MCP_PATH] = mcp;
    this.promptTokens += estimateTokens(spec.prompt);
    return { cmd: this.bin, args: [...this.prefix, ...args], env: { ...spec.env }, files };
  }

  sendFollowUp(sessionId: string, message: string, spec: RunSpec): CommandSpec {
    return this.buildCommand({ ...spec, prompt: message, resumeSessionId: sessionId });
  }

  parseLine(line: string, ctx?: { cwd?: string }): NormalisedEvent[] {
    const o = safeJson(line);
    if (!o) return [];
    const out: NormalisedEvent[] = [];
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init' && typeof o.session_id === 'string') out.push({ kind: 'session.started', sessionId: o.session_id, model: typeof o.model === 'string' ? o.model : undefined });
        break;
      case 'assistant': {
        const content = ((o.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? []);
        const text = content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
        if (text.trim()) { out.push({ kind: 'message.assistant', text }); this.outTokens += estimateTokens(text); }
        break;
      }
      case 'tool_call': {
        const call = (o.tool_call ?? {}) as Record<string, unknown>;
        const { name, body } = cursorToolName(call);
        const id = String(o.call_id ?? (body.args as { toolCallId?: string } | undefined)?.toolCallId ?? `${name}-${this.open.size}`);
        const args = ((body.args ?? (body as { arguments?: unknown }).arguments ?? {}) as Record<string, unknown>);
        if (o.subtype === 'started') {
          this.open.set(id, { name, args });
          out.push({ kind: 'tool.call', tool: name, input: args, id });
          break;
        }
        if (o.subtype !== 'completed') break;
        const started = this.open.get(id);
        this.open.delete(id);
        const res = (body.result ?? {}) as Record<string, unknown>;
        const success = res.success as Record<string, unknown> | undefined;
        const failed = !success && ('error' in res || 'failure' in res || 'rejected' in res || 'timeout' in res);
        const a = started?.args ?? args;
        const p = typeof (success?.path ?? a.path) === 'string' ? relPath(String(success?.path ?? a.path), ctx?.cwd) : undefined;
        const summary = name === 'read' ? `read ${p ?? ''}${success?.totalLines !== undefined ? ` (${String(success.totalLines)} lines)` : ''}`
          : name === 'write' ? `wrote ${p ?? ''}${success?.linesCreated !== undefined ? ` (${String(success.linesCreated)} lines)` : ''}`
          : str(success?.stdout ?? success?.content ?? res.error ?? res.failure ?? success ?? res, 300);
        this.resultTokens += estimateTokens(str(success?.content ?? success?.stdout ?? '', 20_000));
        out.push({ kind: 'tool.result', id, ok: !failed, summary: summary.trim() });
        if (!failed && p && name === 'write') out.push({ kind: 'file.changed', path: p, op: 'add' });
        else if (!failed && p && EDIT_TOOLS.has(name)) out.push({ kind: 'file.changed', path: p, op: 'modify' });
        else if (!failed && p && name === 'delete') out.push({ kind: 'file.changed', path: p, op: 'delete' });
        if (name === 'shell' && typeof a.command === 'string') {
          const code = (success?.exitCode ?? (res.failure as { exitCode?: number } | undefined)?.exitCode ?? (failed ? 1 : 0)) as number;
          out.push({ kind: 'command.run', command: str(a.command, 500), exitCode: code });
        }
        break;
      }
      case 'result':
        // Cursor reports no token counts, so usage is an estimate from text size (see VERSION_NOTES). Cost is left to the price table.
        out.push({ kind: 'usage', inputTokens: this.promptTokens + this.resultTokens, outputTokens: this.outTokens, cachedTokens: 0 });
        if (o.is_error === true) out.push({ kind: 'error', message: str(o.result ?? 'Cursor reported an error') });
        out.push({ kind: 'session.ended', status: o.is_error === true ? 'error' : 'success' });
        this.promptTokens = this.outTokens = this.resultTokens = 0;
        break;
      case 'error':
        out.push({ kind: 'error', message: str(o.message ?? o.error) });
        break;
    }
    return out;
  }

  extractSessionId = firstSession;
  extractUsage = sumUsage;
}

export const createCursorAdapter = () => new CursorAdapter();
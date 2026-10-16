import type { NormalisedEvent } from '@zerovity/core';
import { INSTRUCTIONS_PATH, detectCli, firstSession, relPath, safeJson, str, sumUsage, type CommandSpec, type HarnessAdapter, type RunSpec } from '@zerovity/harness-common';

export const BASE_ALLOWED = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash(git *)', 'Bash(pnpm *)', 'Bash(npm *)', 'Bash(node *)', 'Bash(npx *)'];
/** the container is the security boundary, but pushing is never the agent's job */
export const DENIED = ['Bash(git push*)', 'Bash(git remote*)'];

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class ClaudeCodeAdapter implements HarnessAdapter {
  type = 'claude-code' as const;
  private tools = new Map<string, { name: string; input: Record<string, unknown> }>();

  async detect() {
    return detectCli('claude');
  }

  buildCommand(spec: RunSpec): CommandSpec {
    const allowed = [...BASE_ALLOWED, ...(spec.extraAllowedShell ?? []).map((p) => `Bash(${p})`)];
    const args = [
      '-p', spec.prompt,
      '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt-file', INSTRUCTIONS_PATH,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', allowed.join(','),
      '--disallowedTools', DENIED.join(','),
    ];
    const files: Record<string, string> = {};
    if (spec.mcpServers && Object.keys(spec.mcpServers).length) {
      const mcp: Record<string, unknown> = {};
      for (const [n, s] of Object.entries(spec.mcpServers)) mcp[n] = s.url ? { type: 'http', url: s.url, headers: s.headers ?? {} } : { command: s.command, args: s.args ?? [], env: s.env ?? {} };
      files['.zerovity/run/mcp.json'] = JSON.stringify({ mcpServers: mcp }, null, 2);
      args.push('--mcp-config', '.zerovity/run/mcp.json', '--strict-mcp-config');
    }
    if (spec.agent.harness.model) args.push('--model', spec.agent.harness.model);
    if (spec.resumeSessionId) args.push('--resume', spec.resumeSessionId);
    return { cmd: 'claude', args, env: { ...spec.env }, files };
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
        const content = (o.message as { content?: unknown[] } | undefined)?.content ?? [];
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ kind: 'message.assistant', text: b.text });
          if (b.type === 'tool_use' && typeof b.id === 'string') {
            const input = (b.input ?? {}) as Record<string, unknown>;
            this.tools.set(b.id, { name: String(b.name), input });
            out.push({ kind: 'tool.call', tool: String(b.name), input, id: b.id });
          }
        }
        break;
      }
      case 'user': {
        const content = (o.message as { content?: unknown[] } | undefined)?.content;
        if (!Array.isArray(content)) break;
        const meta = o.tool_use_result as Record<string, unknown> | undefined;
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const text = Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n') : str(b.content, 4000);
          const ok = b.is_error !== true;
          out.push({ kind: 'tool.result', id: b.tool_use_id, ok, summary: str(text, 300) });
          const t = this.tools.get(b.tool_use_id);
          if (!t) continue;
          if (t.name === 'Bash' || t.name === 'PowerShell') {
            const m = /exit code[: ]+(\d+)/i.exec(text);
            out.push({ kind: 'command.run', command: str(t.input.command, 500), exitCode: m ? Number(m[1]) : ok ? 0 : 1 });
          } else if (FILE_TOOLS.has(t.name) && ok) {
            const p = (t.input.file_path ?? t.input.notebook_path) as string | undefined;
            if (p) out.push({ kind: 'file.changed', path: relPath(p, ctx?.cwd), op: meta?.type === 'create' ? 'add' : 'modify' });
          }
        }
        break;
      }
      case 'result': {
        const u = (o.usage ?? {}) as Record<string, number>;
        out.push({
          kind: 'usage',
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          cachedTokens: u.cache_read_input_tokens ?? 0,
          costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined,
        });
        const isErr = o.is_error === true || (typeof o.subtype === 'string' && o.subtype !== 'success');
        if (isErr) out.push({ kind: 'error', message: str(o.result ?? o.subtype ?? 'run failed') });
        out.push({ kind: 'session.ended', status: isErr ? 'error' : 'success' });
        break;
      }
    }
    return out;
  }

  extractSessionId = firstSession;
  extractUsage = sumUsage;
}

export const createClaudeCodeAdapter = () => new ClaudeCodeAdapter();

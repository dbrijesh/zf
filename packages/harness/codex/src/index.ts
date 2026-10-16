import type { NormalisedEvent } from '@zerovity/core';
import { cleanPrompt, detectCli, firstSession, relPath, safeJson, str, sumUsage, type CommandSpec, type HarnessAdapter, type RunSpec } from '@zerovity/harness-common';

/** Codex keeps its config (model providers, MCP servers) in $CODEX_HOME/config.toml. We write one per run. */
export const CODEX_HOME_REL = '.zerovity/run/codex-home';

const tomlStr = (s: string) => JSON.stringify(s);

export function buildCodexConfig(spec: RunSpec): string {
  const lines: string[] = [];
  if (spec.env.OPENAI_BASE_URL) {
    lines.push('model_provider = "zerovity-gateway"', '', '[model_providers.zerovity-gateway]', 'name = "Zerovity gateway"', `base_url = ${tomlStr(spec.env.OPENAI_BASE_URL)}`, 'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"', '');
  }
  for (const [n, s] of Object.entries(spec.mcpServers ?? {})) {
    lines.push(`[mcp_servers.${n}]`);
    if (s.url) {
      lines.push(`url = ${tomlStr(s.url)}`);
      if (s.headers && Object.keys(s.headers).length) lines.push(`http_headers = { ${Object.entries(s.headers).map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`).join(', ')} }`);
    } else {
      lines.push(`command = ${tomlStr(s.command ?? '')}`, `args = [${(s.args ?? []).map(tomlStr).join(', ')}]`);
      if (s.env && Object.keys(s.env).length) lines.push(`env = { ${Object.entries(s.env).map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`).join(', ')} }`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export class CodexAdapter implements HarnessAdapter {
  type = 'codex' as const;
  private threadId?: string;

  async detect() {
    return detectCli('codex');
  }

  buildCommand(spec: RunSpec): CommandSpec {
    const preamble = spec.prompt; // the worker prepends INSTRUCTIONS.md text to the prompt for prompt-prefix harnesses
    const env: Record<string, string> = { ...spec.env, CODEX_HOME: `${spec.worktreePath.replace(/\\/g, '/')}/${CODEX_HOME_REL}` };
    if (env.OPENAI_API_KEY && !env.CODEX_API_KEY) env.CODEX_API_KEY = env.OPENAI_API_KEY;
    const base = ['exec'];
    if (spec.resumeSessionId) base.push('resume', spec.resumeSessionId);
    base.push('--json', '--skip-git-repo-check');
    if (!spec.resumeSessionId) base.push('--sandbox', 'workspace-write');
    if (spec.agent.harness.model) base.push('--model', spec.agent.harness.model);
    if (spec.agent.harness.reasoning) base.push('-c', `model_reasoning_effort=${spec.agent.harness.reasoning}`);
    base.push(cleanPrompt(preamble));
    return { cmd: 'codex', args: base, env, files: { [`${CODEX_HOME_REL}/config.toml`]: buildCodexConfig(spec) } };
  }

  sendFollowUp(sessionId: string, message: string, spec: RunSpec): CommandSpec {
    return this.buildCommand({ ...spec, prompt: message, resumeSessionId: sessionId });
  }

  parseLine(line: string, ctx?: { cwd?: string }): NormalisedEvent[] {
    const o = safeJson(line);
    if (!o) return [];
    const out: NormalisedEvent[] = [];
    const item = o.item as Record<string, unknown> | undefined;
    switch (o.type) {
      case 'thread.started':
        this.threadId = String(o.thread_id);
        out.push({ kind: 'session.started', sessionId: this.threadId, model: typeof o.model === 'string' ? o.model : undefined });
        break;
      case 'item.started':
        if (item?.type === 'command_execution') out.push({ kind: 'tool.call', tool: 'shell', input: { command: item.command }, id: String(item.id) });
        if (item?.type === 'mcp_tool_call') out.push({ kind: 'tool.call', tool: `${item.server}.${item.tool}`, input: item.arguments ?? {}, id: String(item.id) });
        break;
      case 'item.completed':
        if (!item) break;
        switch (item.type) {
          case 'agent_message':
            if (typeof item.text === 'string' && item.text.trim()) out.push({ kind: 'message.assistant', text: item.text });
            break;
          case 'command_execution': {
            const code = typeof item.exit_code === 'number' ? item.exit_code : item.status === 'failed' ? 1 : 0;
            out.push({ kind: 'tool.result', id: String(item.id), ok: code === 0, summary: str(item.aggregated_output, 300) });
            out.push({ kind: 'command.run', command: str(item.command, 500), exitCode: code });
            break;
          }
          case 'file_change':
            for (const c of (item.changes as Array<{ path: string; kind: string }> | undefined) ?? [])
              out.push({ kind: 'file.changed', path: relPath(c.path, ctx?.cwd), op: c.kind === 'add' ? 'add' : c.kind === 'delete' ? 'delete' : 'modify' });
            break;
          case 'mcp_tool_call':
            out.push({ kind: 'tool.result', id: String(item.id), ok: item.status !== 'failed', summary: str(item.result ?? item.error, 300) });
            break;
          case 'error':
            out.push({ kind: 'error', message: str(item.message) });
            break;
        }
        break;
      case 'turn.completed': {
        const u = (o.usage ?? {}) as Record<string, number>;
        out.push({ kind: 'usage', inputTokens: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)), outputTokens: u.output_tokens ?? 0, cachedTokens: u.cached_input_tokens ?? 0 });
        out.push({ kind: 'session.ended', status: 'success' });
        break;
      }
      case 'turn.failed':
        out.push({ kind: 'error', message: str((o.error as { message?: string } | undefined)?.message ?? 'turn failed') });
        out.push({ kind: 'session.ended', status: 'error' });
        break;
      case 'error':
        out.push({ kind: 'error', message: str(o.message) });
        break;
    }
    return out;
  }

  extractSessionId = firstSession;
  extractUsage = sumUsage;
}

export const createCodexAdapter = () => new CodexAdapter();

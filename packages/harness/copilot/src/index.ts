import type { NormalisedEvent } from '@zerovity/core';
import { cleanPrompt, detectCli, firstSession, relPath, safeJson, str, sumUsage, type CommandSpec, type HarnessAdapter, type RunSpec } from '@zerovity/harness-common';

export const COPILOT_CONFIG_REL = '.zerovity/run/copilot-config';

const ALLOW = ['write', 'shell(git:*)', 'shell(pnpm:*)', 'shell(npm:*)', 'shell(node:*)', 'shell(npx:*)'];
const DENY = ['shell(git push)', 'shell(git remote)'];

/**
 * GitHub Copilot CLI adapter. In some versions plain text output does not reach stdout under `-p`
 * (spec 8.2), so we always ask for JSON and read the assistant message events.
 * Event names are matched loosely (dotted or snake case, `data` wrapper optional) because the
 * stream format has changed between releases; see VERSION_NOTES.md.
 */
export class CopilotAdapter implements HarnessAdapter {
  type = 'copilot' as const;

  async detect() {
    return detectCli('copilot');
  }

  buildCommand(spec: RunSpec): CommandSpec {
    const args = ['-p', cleanPrompt(spec.prompt), '--output-format', 'json'];
    for (const a of [...ALLOW, ...(spec.extraAllowedShell ?? []).map((p) => `shell(${p.replace(/ \*$/, ':*')})`)]) args.push('--allow-tool', a);
    for (const d of DENY) args.push('--deny-tool', d);
    if (spec.agent.harness.model) args.push('--model', spec.agent.harness.model);
    if (spec.resumeSessionId) args.push('--resume', spec.resumeSessionId);
    const files: Record<string, string> = {};
    const env: Record<string, string> = { ...spec.env };
    if (env.COPILOT_GITHUB_TOKEN && !env.GH_TOKEN) env.GH_TOKEN = env.COPILOT_GITHUB_TOKEN;
    if (spec.mcpServers && Object.keys(spec.mcpServers).length) {
      const mcp: Record<string, unknown> = {};
      for (const [n, s] of Object.entries(spec.mcpServers)) mcp[n] = s.url ? { type: 'http', url: s.url, headers: s.headers ?? {}, tools: ['*'] } : { type: 'local', command: s.command, args: s.args ?? [], env: s.env ?? {}, tools: ['*'] };
      files[`${COPILOT_CONFIG_REL}/mcp-config.json`] = JSON.stringify({ mcpServers: mcp }, null, 2);
      args.push('--additional-mcp-config', `@${COPILOT_CONFIG_REL}/mcp-config.json`);
    }
    return { cmd: 'copilot', args, env, files };
  }

  sendFollowUp(sessionId: string, message: string, spec: RunSpec): CommandSpec {
    return this.buildCommand({ ...spec, prompt: message, resumeSessionId: sessionId });
  }

  parseLine(line: string, ctx?: { cwd?: string }): NormalisedEvent[] {
    const o = safeJson(line);
    if (!o) return [];
    const t = String(o.type ?? '').replace(/_/g, '.').toLowerCase();
    const d = ((o.data as Record<string, unknown> | undefined) ?? o) as Record<string, unknown>;
    const out: NormalisedEvent[] = [];
    if (t === 'session.start' || t === 'session.started') {
      const id = (d.sessionId ?? d.session_id ?? o.sessionId) as string | undefined;
      if (id) out.push({ kind: 'session.started', sessionId: id, model: (d.selectedModel ?? d.model) as string | undefined });
    } else if (t === 'assistant.message') {
      const text = (d.content ?? d.text) as string | undefined;
      if (text && text.trim()) out.push({ kind: 'message.assistant', text });
      for (const tr of (d.toolRequests as Array<Record<string, unknown>> | undefined) ?? []) {
        if (tr.toolCallId && tr.name) out.push({ kind: 'tool.call', tool: String(tr.name), input: tr.arguments ?? {}, id: String(tr.toolCallId) });
      }
    } else if (t === 'tool.execution.start') {
      out.push({ kind: 'tool.call', tool: String(d.toolName ?? d.name ?? 'tool'), input: d.arguments ?? {}, id: String(d.toolCallId ?? d.id ?? '') });
      const args = (d.arguments ?? {}) as Record<string, unknown>;
      if (/^(bash|shell|powershell)$/i.test(String(d.toolName)) && args.command) out.push({ kind: 'command.run', command: str(args.command, 500) });
      if (/^(create|write|edit|str_replace_editor)/i.test(String(d.toolName)) && typeof args.path === 'string')
        out.push({ kind: 'file.changed', path: relPath(args.path, ctx?.cwd), op: /create/i.test(String(d.toolName)) ? 'add' : 'modify' });
    } else if (t === 'tool.execution.complete') {
      const res = d.result as { content?: string } | string | undefined;
      out.push({ kind: 'tool.result', id: String(d.toolCallId ?? d.id ?? ''), ok: d.success !== false, summary: str(typeof res === 'string' ? res : res?.content, 300) });
    } else if (t === 'result' || t === 'session.shutdown' || t === 'session.end') {
      const usage = (o.usage ?? d.usage ?? {}) as Record<string, number>;
      const mm = d.modelMetrics as Record<string, { usage?: Record<string, number> }> | undefined;
      let inTok = usage.inputTokens ?? usage.input_tokens ?? 0;
      let outTok = usage.outputTokens ?? usage.output_tokens ?? 0;
      let cached = usage.cacheReadTokens ?? usage.cached_tokens ?? 0;
      if (mm) for (const m of Object.values(mm)) { inTok += m.usage?.inputTokens ?? 0; outTok += m.usage?.outputTokens ?? 0; cached += m.usage?.cacheReadTokens ?? 0; }
      const premium = (usage.premiumRequests ?? d.totalPremiumRequests ?? (o as Record<string, unknown>).premiumRequests) as number | undefined;
      out.push({ kind: 'usage', inputTokens: inTok, outputTokens: outTok, cachedTokens: cached, premiumRequests: typeof premium === 'number' ? premium : undefined });
      const exit = (o.exitCode ?? d.exitCode) as number | undefined;
      out.push({ kind: 'session.ended', status: exit && exit !== 0 ? 'error' : 'success' });
    } else if (t === 'error' || t === 'session.error') {
      out.push({ kind: 'error', message: str(d.message ?? d.error ?? o.message) });
    }
    return out;
  }

  extractSessionId = firstSession;
  extractUsage = sumUsage;
}

export const createCopilotAdapter = () => new CopilotAdapter();

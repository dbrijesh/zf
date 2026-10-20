import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { NormalisedEvent } from '@zerovity/core';
import { createAdapter, buildPreamble, type RunSpec, type HarnessAdapter } from '../src';

const here = path.resolve(__dirname, '..');
const replay = (a: HarnessAdapter, file: string, cwd = '/workspace'): NormalisedEvent[] =>
  fs.readFileSync(path.join(here, file), 'utf8').split('\n').flatMap((l) => a.parseLine(l, { cwd }));

const spec = (over: Partial<RunSpec> = {}, harness: RunSpec['agent']['harness'] = { type: 'claude-code', model: 'm1' }): RunSpec => ({
  runId: 'r1', workItemId: 'ZF-1',
  agent: { name: 'zerovity-executor', phase: 'BUILD', body: 'body', skills: [], outputs: [], harness, mcpServers: [] },
  prompt: 'do the thing', worktreePath: '/workspace', env: { ANTHROPIC_API_KEY: 'k' }, limits: { maxMinutes: 10, maxTokens: 1000 }, ...over,
});

describe('claude-code (recorded fixture)', () => {
  const a = createAdapter('claude-code');
  const ev = replay(a, 'claude-code/fixtures/basic-run.jsonl');
  it('extracts session, tool call, file change, message, usage and end', () => {
    expect(a.extractSessionId(ev)).toBe('3eb7ef99-39e2-4685-b4af-083658e3a911');
    expect(ev.find((e) => e.kind === 'tool.call')).toMatchObject({ tool: 'Write' });
    expect(ev.find((e) => e.kind === 'file.changed')).toEqual({ kind: 'file.changed', path: 'hello.txt', op: 'add' });
    expect(ev.find((e) => e.kind === 'message.assistant')).toMatchObject({ text: 'done' });
    expect(ev[ev.length - 1]).toEqual({ kind: 'session.ended', status: 'success' });
    const u = a.extractUsage(ev);
    expect(u.outputTokens).toBe(107);
    expect(u.cachedTokens).toBe(23027);
    expect(u.costUsd).toBeCloseTo(0.0962567, 6);
  });
  it('builds the spec command line', () => {
    const c = a.buildCommand(spec({ resumeSessionId: 'abc', extraAllowedShell: ['pytest *'] }));
    expect(c.cmd).toBe('claude');
    expect(c.args).toEqual(expect.arrayContaining(['-p', 'do the thing', '--output-format', 'stream-json', '--verbose', '--append-system-prompt-file', '.zerovity/run/INSTRUCTIONS.md', '--permission-mode', 'acceptEdits', '--model', 'm1', '--resume', 'abc']));
    const allowed = c.args[c.args.indexOf('--allowedTools') + 1];
    expect(allowed).toContain('Bash(git *)');
    expect(allowed).toContain('Bash(pytest *)');
    expect(c.args[c.args.indexOf('--disallowedTools') + 1]).toContain('git push');
  });
  it('writes a per-run mcp config', () => {
    const c = a.buildCommand(spec({ mcpServers: { jira: { url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } } } }));
    expect(JSON.parse(c.files!['.zerovity/run/mcp.json'])).toEqual({ mcpServers: { jira: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } } } });
    expect(c.args).toContain('--strict-mcp-config');
  });
  it('maps error results and ignores junk lines', () => {
    const b = createAdapter('claude-code');
    expect(b.parseLine('not json')).toEqual([]);
    expect(b.parseLine('{"type":"result","subtype":"error_max_turns","is_error":true,"usage":{"input_tokens":1,"output_tokens":2},"result":"too many turns"}').map((e) => e.kind)).toEqual(['usage', 'error', 'session.ended']);
  });
  it('tracks Bash commands with exit codes', () => {
    const b = createAdapter('claude-code');
    b.parseLine('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Bash","input":{"command":"npm test"}}]}}');
    const r = b.parseLine('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"Exit code 2\\nfail","is_error":true}]}}');
    expect(r).toContainEqual({ kind: 'command.run', command: 'npm test', exitCode: 2 });
  });
});

describe('codex (synthetic fixture, see VERSION_NOTES)', () => {
  const a = createAdapter('codex');
  const ev = replay(a, 'codex/fixtures/basic-run.jsonl');
  it('parses thread, commands, file changes, message and usage', () => {
    expect(a.extractSessionId(ev)).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
    expect(ev.filter((e) => e.kind === 'command.run')).toEqual([
      { kind: 'command.run', command: 'bash -lc ls', exitCode: 0 },
      { kind: 'command.run', command: "bash -lc 'npm test'", exitCode: 1 },
    ]);
    expect(ev.filter((e) => e.kind === 'file.changed')).toEqual([
      { kind: 'file.changed', path: 'src/a.ts', op: 'modify' },
      { kind: 'file.changed', path: 'src/b.ts', op: 'add' },
    ]);
    expect(a.extractUsage(ev)).toMatchObject({ inputTokens: 315, outputTokens: 122, cachedTokens: 24448 });
  });
  it('builds exec and resume commands with per-run CODEX_HOME', () => {
    const s = spec({ mcpServers: { jira: { url: 'https://x/mcp', headers: { A: 'b' } } }, env: { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://gw/v1' } }, { type: 'codex', model: 'gpt-5-codex', reasoning: 'high' });
    const c = a.buildCommand(s);
    expect(c.args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(c.args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write', '--model', 'gpt-5-codex', '-c', 'model_reasoning_effort=high']));
    expect(c.env.CODEX_HOME).toContain('.zerovity/run/codex-home');
    const toml = Object.values(c.files!)[0];
    expect(toml).toContain('[mcp_servers.jira]');
    expect(toml).toContain('base_url = "https://gw/v1"');
    const r = a.buildCommand({ ...s, resumeSessionId: 'thread-1' });
    expect(r.args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1']);
  });
  it('maps turn.failed', () => {
    expect(createAdapter('codex').parseLine('{"type":"turn.failed","error":{"message":"boom"}}')).toEqual([{ kind: 'error', message: 'boom' }, { kind: 'session.ended', status: 'error' }]);
  });
});

describe('copilot (synthetic fixture, see VERSION_NOTES)', () => {
  const a = createAdapter('copilot');
  const ev = replay(a, 'copilot/fixtures/basic-run.jsonl');
  it('reads assistant.message events, tools, session and premium requests', () => {
    expect(a.extractSessionId(ev)).toBe('c0ffee00-1111-2222-3333-444455556666');
    expect(ev.find((e) => e.kind === 'message.assistant')).toMatchObject({ text: 'done' });
    expect(ev).toContainEqual({ kind: 'file.changed', path: 'hello.txt', op: 'add' });
    expect(ev).toContainEqual({ kind: 'command.run', command: 'git status --short' });
    expect(a.extractUsage(ev)).toMatchObject({ inputTokens: 9100, outputTokens: 140, premiumRequests: 1 });
  });
  it('builds a command that denies push and always asks for json', () => {
    const c = a.buildCommand(spec({ env: { COPILOT_GITHUB_TOKEN: 't' } }, { type: 'copilot' }));
    expect(c.cmd).toBe('copilot');
    expect(c.args).toEqual(expect.arrayContaining(['--output-format', 'json', '--deny-tool', 'shell(git push)']));
    expect(c.env.GH_TOKEN).toBe('t');
  });
  it('tolerates snake_case and unwrapped events', () => {
    expect(createAdapter('copilot').parseLine('{"type":"assistant_message","content":"hi"}')).toEqual([{ kind: 'message.assistant', text: 'hi' }]);
  });
});

describe('preamble', () => {
  it('has the same shape for every harness (spec 8.3)', () => {
    const p = buildPreamble({ agent: { name: 'zerovity-executor', body: 'Build it.', outputs: ['evidence.md'], skills: [{ name: 's1', description: 'Use when x.' }] }, phase: 'BUILD', workItemId: 'ZF-9', title: 'Fix it' });
    expect(p.split('\n')[0]).toBe('You are zerovity-executor, working phase BUILD of work item ZF-9: "Fix it".');
    expect(p).toContain('.zerovity/context/CONTEXT.md');
    expect(p).toContain('.zerovity/out/result.json');
    expect(p).toContain('Do not push, merge, or change git remotes.');
    expect(p).toContain('- s1 - Use when x.');
  });
});

describe('fake adapter', () => {
  it('parses its own normalised events and builds a node command', () => {
    const a = createAdapter('fake');
    expect(a.parseLine('{"kind":"message.assistant","text":"x"}')).toHaveLength(1);
    expect(a.parseLine('{"kind":"bogus"}')).toEqual([]);
    expect(a.buildCommand(spec({ resumeSessionId: 's' }, { type: 'fake' })).env.ZF_FAKE_RESUME).toBe('s');
  });
});

describe('cursor (documented shapes; synthetic fixture)', () => {
  const a = createAdapter('cursor');
  const ev = replay(a, 'cursor/fixtures/basic-run.jsonl', '/workspace/work');
  it('maps session, messages, tool calls, files, commands and the end', () => {
    expect(a.extractSessionId(ev)).toBe('c1f0a7de-5b0e-4a63-9a1e-0f6d2f9c7a11');
    expect(ev.find((e) => e.kind === 'session.started')).toMatchObject({ model: 'Claude 4 Sonnet' });
    expect(ev.filter((e) => e.kind === 'message.assistant').map((e) => (e as { text: string }).text)).toEqual(["I'll read the README first, then create hello.txt.", 'done']);
    expect(ev.filter((e) => e.kind === 'tool.call').map((e) => (e as { tool: string }).tool)).toEqual(['read', 'write', 'shell', 'shell']);
    expect(ev.find((e) => e.kind === 'file.changed')).toEqual({ kind: 'file.changed', path: 'hello.txt', op: 'add' });
    expect(ev.filter((e) => e.kind === 'tool.result').map((e) => (e as { ok: boolean }).ok)).toEqual([true, true, true, false]);
    expect(ev.filter((e) => e.kind === 'command.run')).toEqual([{ kind: 'command.run', command: 'cat hello.txt', exitCode: 0 }, { kind: 'command.run', command: 'false', exitCode: 1 }]);
    expect(ev[ev.length - 1]).toEqual({ kind: 'session.ended', status: 'success' });
  });
  it('tool results pair with their calls by call_id', () => {
    const calls = ev.filter((e) => e.kind === 'tool.call').map((e) => (e as { id: string }).id);
    const results = ev.filter((e) => e.kind === 'tool.result').map((e) => (e as { id: string }).id);
    expect(results).toEqual(calls);
  });
  it('reports estimated tokens (the CLI gives none) and no invented cost', () => {
    const usage = (prompt: string) => { const b = createAdapter('cursor'); b.buildCommand(spec({ prompt }, { type: 'cursor' })); return b.extractUsage(replay(b, 'cursor/fixtures/basic-run.jsonl')); };
    const small = usage('hi'), big = usage('explain the whole repository in great detail '.repeat(200));
    expect(small.outputTokens).toBeGreaterThan(0);
    expect(big.inputTokens).toBeGreaterThan(small.inputTokens + 500); // the prompt size is counted
    expect(big.outputTokens).toBe(small.outputTokens);
    expect(small.costUsd).toBeUndefined();
  });
  it('builds a headless command with force, trust, model, resume and the API key only via env', () => {
    const c = createAdapter('cursor').buildCommand(spec({ resumeSessionId: 'chat-1', env: { CURSOR_API_KEY: 'k' } }, { type: 'cursor', model: 'auto' }));
    expect(c.args).toEqual(expect.arrayContaining(['-p', 'do the thing', '--output-format', 'stream-json', '--force', '--trust', '--model', 'auto', '--resume', 'chat-1']));
    expect(c.args.join(' ')).not.toContain('CURSOR_API_KEY');
    expect(c.args).not.toContain('k');
    expect(c.env.CURSOR_API_KEY).toBe('k');
    expect(c.args).not.toContain('--approve-mcps');
  });
  it('writes deny rules, and MCP config only when the agent has MCP servers', () => {
    const none = createAdapter('cursor').buildCommand(spec({}, { type: 'cursor' }));
    expect(Object.keys(none.files ?? {})).toEqual(['.cursor/cli.json']);
    expect(JSON.parse(none.files!['.cursor/cli.json']).permissions.deny).toEqual(expect.arrayContaining(['Shell(gh)', 'Read(.env*)']));
    const withMcp = createAdapter('cursor').buildCommand(spec({ mcpServers: { jira: { url: 'https://mcp.example/jira', headers: { Authorization: 'Bearer t' } } } }, { type: 'cursor' }));
    expect(withMcp.args).toContain('--approve-mcps');
    expect(JSON.parse(withMcp.files!['.cursor/mcp.json']).mcpServers.jira).toEqual({ url: 'https://mcp.example/jira', headers: { Authorization: 'Bearer t' } });
  });
  it('a follow-up resumes the same chat', () => {
    const c = createAdapter('cursor').sendFollowUp!('chat-9', 'please fix', spec({}, { type: 'cursor' }));
    expect(c.args).toEqual(expect.arrayContaining(['-p', 'please fix', '--resume', 'chat-9']));
  });
  it('an error result surfaces as an error event and an error end', () => {
    const b = createAdapter('cursor');
    const out = b.parseLine('{"type":"result","subtype":"success","is_error":true,"result":"boom","session_id":"s"}');
    expect(out.map((e) => e.kind)).toEqual(['usage', 'error', 'session.ended']);
    expect(out[2]).toEqual({ kind: 'session.ended', status: 'error' });
  });
  it('unknown tools and malformed lines never throw', () => {
    const b = createAdapter('cursor');
    expect(() => { b.parseLine('not json'); b.parseLine('{"type":"tool_call","subtype":"started","call_id":"z","tool_call":{"mysteryToolCall":{"args":{"q":1}}}}'); b.parseLine('{"type":"tool_call","subtype":"completed","call_id":"z","tool_call":{"mysteryToolCall":{"args":{},"result":{"success":{"x":1}}}}}'); }).not.toThrow();
  });
});
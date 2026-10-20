// A stand-in for the Cursor CLI used by tests (ZF_CURSOR_BIN=node, ZF_CURSOR_ARGS=["<this file>"]).
// It speaks the documented stream-json format and writes a valid result.json, so the whole adapter path can run without Cursor installed.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2025.10.01-faketest'); process.exit(0); }
if (args.includes('--help')) { console.log('Cursor Agent (fake)'); process.exit(0); }
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const prompt = val('-p') ?? '';
const sid = val('--resume') ?? 'fake-cursor-session-1';
const out = (o) => console.log(JSON.stringify({ ...o, session_id: sid }));

// record how we were called, so the test can assert on flags and on the environment the agent got
fs.mkdirSync('.zerovity/out', { recursive: true });
fs.writeFileSync('.zerovity/out/argv.json', JSON.stringify({ args, key: process.env.CURSOR_API_KEY ?? null, hasCliConfig: fs.existsSync('.cursor/cli.json') }));

out({ type: 'system', subtype: 'init', apiKeySource: 'env', cwd: process.cwd(), model: 'fake-model', permissionMode: 'default' });
out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt.slice(0, 40) }] } });
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Writing the triage.' }] } });
out({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { writeToolCall: { args: { path: '.zerovity/out/triage.md', fileText: '# Triage\n' } } } });
fs.writeFileSync('.zerovity/out/triage.md', '# Triage\nsmall change\n');
out({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { writeToolCall: { args: { path: '.zerovity/out/triage.md' }, result: { success: { path: path.resolve('.zerovity/out/triage.md'), linesCreated: 2, fileSize: 22 } } } } });
fs.writeFileSync('.zerovity/out/result.json', JSON.stringify({ status: 'done', summary: 'Triage written by the fake Cursor agent.', questions: [], artifacts: [{ path: 'triage.md' }], evidence: [] }));
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
out({ type: 'result', subtype: 'success', duration_ms: 12, duration_api_ms: 12, is_error: false, result: 'Writing the triage.done' });
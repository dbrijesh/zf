# VERSION_NOTES - cursor

Built against: **not installed on the build machine** (the Cursor CLI installer was not run). Written from the official
Cursor documentation (cursor.com/docs/cli: headless, output-format, parameters, permissions, skills), read on 2026-10-20.

Verified against the docs:
- Binary is `agent` (older installs: `cursor-agent`). Headless: `agent -p "<prompt>" --output-format stream-json`.
- `--force` (alias `--yolo`) is required for file edits and commands; `--trust` trusts the workspace in headless mode;
  `--approve-mcps` auto-approves MCP servers; `--model <m>`; `--resume <chatId>`; `CURSOR_API_KEY` for auth.
- stream-json events: `system/init` (session_id, model), `user`, `assistant` (message.content[].text),
  `tool_call` `started|completed` (call_id, tool_call.<name>ToolCall.{args,result}), terminal `result`
  (duration_ms, is_error, result, session_id). `readToolCall` and `writeToolCall` shapes are documented.
- Skills: `.cursor/skills/<name>/SKILL.md` (Cursor also reads `.agents/skills`, `.claude/skills`).
- Project permissions: `.cursor/cli.json` with `permissions.allow|deny` of `Shell(...)`, `Read(...)`, `Write(...)`.

NOT documented, so assumed (check with a real recording):
- `shellToolCall` args (`command`) and result (`success|failure` with `exitCode`, `stdout`) and the names of other tools
  (`edit`, `delete`, `grep`, ...). Unknown tools still appear as generic `tool.call` / `tool.result` events.
- The exact syntax of deny entries such as `Shell(git:push*)`.
- `.cursor/mcp.json` uses the standard `mcpServers` format shared with the editor (stdio: command/args/env; remote: url/headers).

Usage: the CLI reports **no token counts**. The adapter estimates tokens from text size (prompt, assistant text and tool output)
and leaves cost to the price table, so Cursor costs are indicative only. Cursor itself bills against your plan or request quota.

`fixtures/basic-run.jsonl` is **synthetic** (hand written from the documented shapes). To replace it with a recording:
run `agent -p "write hello.txt" --output-format stream-json --force --trust` on a machine with Cursor installed, strip secrets,
save it here and run `npm test`.

On Windows the native installer provides a shim that the local sandbox cannot launch; use the Docker sandbox or WSL.
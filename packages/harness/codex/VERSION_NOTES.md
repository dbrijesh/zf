# VERSION_NOTES - codex

Built against: **not installed on the build machine** (no `codex` binary available when this adapter was written).

- Command line and JSONL event names follow the documented `codex exec --json` stream:
  `thread.started`, `turn.started`, `item.started|completed` (`agent_message`, `command_execution`,
  `file_change`, `mcp_tool_call`, `reasoning`, `error`), `turn.completed` (with `usage`), `turn.failed`, `error`.
- `fixtures/basic-run.jsonl` is **synthetic** (hand written from the documented shapes), not a recording.
  **TODO (M3 acceptance):** run `codex exec --json "..."` on a machine with Codex installed, replace the
  fixture with a secret-stripped recording and re-run `npm test`.
- Skills path `.agents/skills/<name>/SKILL.md` and per-run `CODEX_HOME/config.toml` for gateway + MCP are
  assumptions to verify with `codex --help` and the current Codex docs.
- Flags used: `exec`, `resume <id>`, `--json`, `--sandbox workspace-write`, `--skip-git-repo-check`, `--model`, `-c model_reasoning_effort=...`.
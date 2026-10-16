# VERSION_NOTES - claude-code

Built against: **Claude Code 2.1.300** (`claude --version`), Windows, October 2026.

- `fixtures/basic-run.jsonl` is a **real recording** of `claude -p ... --output-format stream-json --verbose`
  (one Write tool call), trimmed of the init tool list, rate-limit events and local paths.
- Verified flags: `-p`, `--output-format stream-json`, `--verbose`, `--append-system-prompt-file`, `--permission-mode acceptEdits`,
  `--allowedTools`, `--disallowedTools`, `--mcp-config`, `--strict-mcp-config`, `--model`, `--resume`.
- Events used: `system/init` (session id, model), `assistant` (text, tool_use, usage), `user` (tool_result),
  `result` (usage totals, `total_cost_usd`, `is_error`, `subtype`).
- Skills path `.claude/skills/<name>/SKILL.md`.
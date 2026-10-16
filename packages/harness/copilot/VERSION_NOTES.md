# VERSION_NOTES - copilot

Built against: **not installed on the build machine** (no `copilot` binary available when this adapter was written).

- Command line follows spec 8.2: `copilot -p ... --output-format json --allow-tool ... --deny-tool ...`.
- The JSON stream format has changed between releases, so the parser matches event names loosely
  (`assistant.message`, `tool.execution_start|complete`, `session.start`, `result`), with or without a `data` wrapper.
- `fixtures/basic-run.jsonl` is **synthetic**, not a recording.
  **TODO (M3 acceptance):** record real output with `copilot -p "..." --output-format json`, strip secrets,
  replace the fixture and adjust `parseLine` if names differ.
- To verify: skills path `.github/skills/<name>/SKILL.md` (fallback `.claude/skills/`), the MCP flag
  `--additional-mcp-config @file`, `--resume`, and how premium requests are reported.
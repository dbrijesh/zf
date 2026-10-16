---
name: zerovity-evidence-capture
description: "Collect proof that each acceptance criterion holds (test output, command logs, screenshots, diffs) under .zerovity/out. Use at the end of BUILD and during VERIFY."
zerovity:
  version: 1.0.0
  phases: [BUILD, VERIFY]
  consumes: [spec.md, validation.log]
  produces: [evidence.md, result.json#evidence]
  escalate: Report a criterion as unproven rather than inventing evidence for it.
---

# Evidence capture

Evidence lets a reviewer trust the work without redoing it. Capture it as you finish each criterion, not at the end.

## What counts

| Criterion checked by | Evidence |
|---|---|
| unit / integration / e2e test | command, exit code, and the names of the passing tests that cover it |
| screenshot | image saved as `.zerovity/out/evidence/<AC>.png`, with the page and state described |
| log check | the log lines, trimmed, with the command that produced them |
| manual | numbered steps performed and what was observed |

## Procedure

1. Open the spec's traceability table. For each AC run the check named there and save the output under `.zerovity/out/evidence/`.
2. Write `.zerovity/out/evidence.md` as a table: `AC | check | result | file`.
3. Add every command as an entry in `result.json` `evidence` with `command`, `exitCode` and `logPath`.
4. Add the changed-files list: the diff summary (`files changed, insertions, deletions`) and each path.
5. Mark any criterion you could not prove as `unproven`, with the reason. Never mark it passed without a saved output.

## Rules

- Keep logs trimmed to what matters (first failure, last 40 lines). Full logs stay in files.
- Remove secrets, tokens, personal data and absolute paths from everything saved.
- Evidence must come from this branch's code. Re-run after any later change.

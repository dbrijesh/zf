---
name: zerovity-repo-validation
description: Find and run the repository's own build, lint, type check and test commands and record the results. Use after implementing changes and before handing work to verification.
zerovity:
  version: 1.0.0
  phases: [BUILD, VERIFY]
  consumes: [CONTEXT.md]
  produces: [validation.log, result.json#evidence]
  escalate: Ask when the repository has no runnable test command or setup needs credentials you do not have.
---

# Repository validation

Use the commands the repository already defines. Do not invent a new toolchain.

## Find the commands

1. Read CONTEXT.md for "how to run tests". If present, use it.
2. Otherwise read, in order: `AGENTS.md`, `CLAUDE.md`, `README`, `CONTRIBUTING`, then build files (`package.json` scripts, `Makefile`, `pyproject.toml`, `pom.xml`, `build.gradle`, `*.csproj`, CI workflow files).
3. Write the discovered commands at the top of `.zerovity/out/validation.log`, with the file you found each in.

## Run in this order, stopping at the first hard failure

1. Install or restore dependencies (only if the environment needs it).
2. Build or compile.
3. Type check.
4. Lint and format check on changed files.
5. Unit tests, then integration tests that run without external services.

## Record

For each command write to `validation.log`: the command, exit code, duration, and the last 40 lines of output on failure. Add one entry per command to `result.json` evidence:

```
{ "type": "test_run", "command": "<cmd>", "exitCode": 0, "logPath": ".zerovity/out/validation.log" }
```

## Rules

- A failure caused by your change must be fixed, not reported.
- A failure that also happens without your change (check by stashing or reading CI history) is pre-existing. Report it as a finding with the evidence; do not fix it unless the spec says so.
- Never skip, mark as expected-fail or delete tests to get green.
- Do not paste secrets or environment dumps into the log.
- If a command needs a service you cannot start (database, queue), say exactly which and which tests were therefore not run.

---
name: zerovity-repro
description: Reproduce a reported bug or flaky behaviour with a minimal failing check before anyone fixes it. Use in INTENT when the request describes something broken.
zerovity:
  version: 1.0.0
  phases: [INTENT, BUILD]
  consumes: [CONTEXT.md, triage.md]
  produces: [repro.md]
  escalate: Ask for logs, data or environment details when the failure cannot be triggered after three honest attempts.
---

# Reproduce first

A fix without a reproduction is a guess. Produce the smallest check that fails for the reported reason.

## Procedure

1. Extract from the request: expected behaviour, actual behaviour, inputs, environment, frequency.
2. Find the narrowest place to exercise it: an existing test file, a script, or a function call. Prefer an automated test over manual steps.
3. Write the check so it fails now and would pass once the bug is fixed. Run it. Record the exact command and the failing output (first 30 lines).
4. If it does not fail:
   - Vary the inputs (empty, large, unicode, boundary values, concurrent calls).
   - For flaky behaviour run it 20 times or with different seeds, and record the failure rate.
   - Check the versions and configuration named in the request.
5. If you still cannot trigger it after three variations, stop and ask for what is missing (logs, data sample, steps) using the question-asking skill.

## Output

Write `.zerovity/out/repro.md`:

- **Command**: the exact line to run.
- **Result**: failing output, trimmed.
- **Cause hypothesis**: one or two sentences, with file and line, clearly marked as hypothesis.
- **Check location**: where the failing check lives (commit it on the branch if it is a test).

## Rules

- Do not fix the bug in this phase.
- Do not weaken or delete an existing test to get a failure.
- Do not hit production systems or real customer data. Use fixtures.

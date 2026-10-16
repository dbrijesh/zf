---
name: zerovity-test-gap
description: Find behaviours in a change that no test would catch if they broke. Use in VERIFY after reading the diff and running the suite.
zerovity:
  version: 1.0.0
  phases: [VERIFY]
  consumes: [spec.md, diff]
  produces: [test-gaps.md, result.json#findings]
  escalate: Escalate when a high-risk path can only be tested manually and no one has owned that manual check.
---

# Test gap analysis

Passing tests only matter if they would fail when the behaviour breaks.

## Procedure

1. List the behaviours the diff adds or changes: each branch, error path, boundary and side effect.
2. For each behaviour find the test that exercises it. Note the file and test name.
3. Probe each test with a mental mutation: if this condition flipped, this value changed by one, or this call was removed, would the test fail? If not, the test does not guard that behaviour.
4. Where practical, prove it: make the mutation locally, run the one test, confirm whether it fails, then restore the original code exactly (check with a diff that the working tree is back to the reviewed state).
5. Look for these common gaps:
   - Only the happy path is tested.
   - Assertions check that something ran, not what it produced.
   - Mocks return exactly what the code expects, so the real dependency is never exercised.
   - Boundaries (limit, limit plus one, empty, null) untested.
   - Error handling and rollback untested.
   - Time, randomness or ordering make the test pass by luck.
6. Write `.zerovity/out/test-gaps.md`: a table of behaviour, existing test, gap, and a one-line description of the test to add. Add the important ones to `findings` (severity `medium`, or `high` for money, auth and data-loss paths).

## Rules

- Never leave a mutation in the working tree. If you cannot restore it cleanly, say so and stop.
- Do not write the missing tests; describe them precisely so the executor can.
- Count only tests that run in the repository's normal test command.

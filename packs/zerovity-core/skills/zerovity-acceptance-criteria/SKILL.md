---
name: zerovity-acceptance-criteria
description: Write testable Given/When/Then acceptance criteria for a requirement. Use when drafting or reviewing a spec, or when a requirement cannot be checked yet.
zerovity:
  version: 1.0.0
  phases: [SPEC, VERIFY]
  consumes: [spec.md, CONTEXT.md]
  produces: [spec.md#acceptance-criteria]
  escalate: Ask the requester when a criterion depends on a business rule not found in context.
---

# Acceptance criteria

A criterion is good when a stranger could run it and agree on pass or fail.

## Rules

1. One observable behaviour per criterion. If the sentence contains "and", split it.
2. Use Given / When / Then with concrete values ("a $12,000 refund", not "a large refund").
3. Each criterion names how it will be checked: `unit test`, `integration test`, `e2e test`, `screenshot`, `log check`, or `manual` (manual needs numbered steps).
4. Tag each criterion with the requirement it proves: `AC3 (R2)`.
5. Cover, for every requirement: the normal path, one boundary on each side of any limit, one invalid input, one failure of a dependency.
6. State the exact expected value, message, status or side effect. Avoid "works", "correct", "fast", "appropriate". Replace with numbers: "responds within 300 ms at the 95th percentile with 50 concurrent calls".

## Procedure

1. List the requirements. For each, write the happy-path criterion first.
2. Add boundary, invalid-input and failure criteria using the rules above.
3. Add security and data criteria when the requirement touches permissions, personal data or money.
4. Check coverage: every requirement has at least two criteria, and nothing is checked only manually if a test is possible.
5. Delete duplicates. Prefer fewer criteria that each prove something.

## Reviewing someone else's criteria

Mark each criterion `ok`, `vague` (cannot be checked as written), or `missing` (a behaviour in the requirement has none). Return the list with a suggested rewrite for each `vague`.

## References

Read references/edge-cases.md only when the spec covers payments, money amounts, dates and time zones, or personal data.

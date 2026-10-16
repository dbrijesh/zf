---
name: zerovity-review-checklist
description: Independently review a change against its spec, tests and repository conventions and return accept, revise or escalate with ranked findings. Use as the main procedure in VERIFY.
zerovity:
  version: 1.0.0
  phases: [VERIFY]
  consumes: [spec.md, CONTEXT.md, diff]
  produces: [review.md, result.json#findings, result.json#recommendation]
  escalate: Recommend escalate when you cannot judge correctness or a decision belongs to a human owner.
---

# Review checklist

You did not write this code. Read it as if you will own it.

## Procedure

1. Read the spec first, then the diff. List each requirement and mark where the diff implements it. A requirement with no matching code is a high finding.
2. For each acceptance criterion find the test that proves it. Run the tests yourself. A criterion with no test, or a test that cannot fail, is a finding.
3. Walk the diff file by file against the checks below.
4. Rank findings: `critical` (data loss, security hole, wrong money), `high` (spec requirement unmet, unsafe behaviour), `medium` (maintainability, missing edge case), `low` (style, naming).
5. Choose the recommendation:
   - `accept`: no critical or high findings and all criteria proven.
   - `revise`: fixable findings exist. List exactly what to change.
   - `escalate`: needs a human decision, or the spec itself looks wrong.
6. Write `.zerovity/out/review.md` (summary, findings table, criteria status) and fill `findings` and `recommendation` in result.json. Give every finding file, line and a one-sentence fix.

## Checks

- **Correctness**: logic matches the requirement; boundaries; error paths; concurrency; null and empty inputs.
- **Tests**: new behaviour tested; assertions meaningful; no skipped or weakened tests; no test that only mirrors the implementation.
- **Conventions**: naming, structure, error handling, logging as in surrounding code and in `AGENTS.md`.
- **Scope**: nothing beyond the spec; no unrelated reformatting; no leftover debug code or commented-out code.
- **Compatibility**: public interfaces, migrations reversible, configuration documented.
- **Security and data**: run the security-scan skill when auth, input handling, secrets, money or personal data are touched.

## Rules

- Be specific and short. "Line 42: amount compared as float; use integer cents" beats "check money handling".
- Do not fix code yourself. Report.
- Do not repeat findings from an earlier review that are now fixed; confirm them closed.

---
name: zerovity-evidence-bundle
description: Assemble a single evidence bundle with the spec, review, test results and approvals index for audit. Use in SHIP after the PR description is written.
zerovity:
  version: 1.0.0
  phases: [SHIP]
  consumes: [spec.md, review.md, evidence.md, validation.log]
  produces: [evidence-bundle/INDEX.md]
  escalate: Do not complete the bundle when a required artifact is missing; list it and ask.
---

# Evidence bundle

Auditors in regulated settings need one place that shows what was asked, what was approved, what was built and how it was checked.

## Layout

```
.zerovity/out/evidence-bundle/
  INDEX.md            summary and the table below
  spec.md             the approved spec (copy)
  review.md           the latest verification review
  validation.log      test and build output
  evidence/           screenshots and extra logs
```

## Procedure

1. Copy the files above from `.zerovity/out/` into the bundle folder. Do not edit their content.
2. Compute the SHA-256 of each file and write it in INDEX.md. Use whichever hashing command the environment offers.
3. In INDEX.md write: work item ID and title, source link, branch and PR, the list of runs if CONTEXT.md provides them, and the table:

| Item | File | SHA-256 | Notes |
|---|---|---|---|

4. List open flags: unproven criteria, escalations, pre-existing failures.
5. Add an `artifacts` entry in result.json for INDEX.md with type `evidence_bundle`.

## Rules

- Missing artifact means missing row with the reason. Never fabricate or backfill content.
- Remove secrets and personal data from copied logs before hashing (hash the cleaned file).
- Approvals (who, when, why) are recorded by the platform's audit log, not by you. Reference it in INDEX.md as "see platform audit log".

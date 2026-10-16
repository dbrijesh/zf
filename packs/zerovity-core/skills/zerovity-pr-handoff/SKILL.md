---
name: zerovity-pr-handoff
description: Write the final pull request description and changelog entry that hand finished work to a person. Use in SHIP once verification is done.
zerovity:
  version: 1.0.0
  phases: [SHIP]
  consumes: [spec.md, review.md, evidence.md, CONTEXT.md]
  produces: [pr-description.md, changelog-entry.md]
  escalate: Flag in the PR when verification recommended escalate or revision loops ran out.
---

# PR handoff

The reader is a person deciding whether to merge. Give them what they need in two minutes.

## Description template

```
## What and why
<2-3 sentences: the outcome for users, the work item link, the spec link>

## What changed
<bullets by area, each tied to a requirement: "R2: refunds >= $10k move to PENDING_2ND">

## How it was checked
<table: acceptance criterion | check | result>   (from evidence.md)

## Review notes
<what to look at first; risky areas; decisions made; open points from the spec>

## Flags
<unproven criteria, pre-existing failures, escalations, revision loops used; or "None">

Work item: <ID> · Source: <issue or ticket link> · Branch: <branch>
```

## Procedure

1. Read the spec, the latest review and the evidence. Use only facts found there.
2. Fill the template. Every claim about checks must trace to evidence; if it is not there, list it under Flags.
3. State honestly what was not run or not proven.
4. Write the changelog entry in the repository's format (look at the top of `CHANGELOG.md`); one to three lines, user-facing wording, with the work item ID. If the repository has no changelog, skip this output.
5. Save both files to `.zerovity/out/`.

## Rules

- Never say "all tests pass" unless the evidence shows a run that did.
- No marketing language. Plain, specific sentences.
- Do not merge, approve or request reviewers. A person does that.

---
name: zerovity-spec-format
description: Write a product plus technical spec in the Zerovity format with numbered requirements, each tied to a validation criterion. Use when producing or restructuring spec.md.
zerovity:
  version: 1.0.0
  phases: [SPEC]
  consumes: [triage.md, CONTEXT.md]
  produces: [spec.md]
  escalate: Ask the requester when two requirements conflict or a requirement has no way to be verified.
---

# Spec format

One spec per work item, saved as `.zerovity/out/spec.md` and copied to `docs/specs/<work-item-id>.md` by the platform.

## Structure

```
# <ID> <title>
Status: Draft | Approved | Implemented
## 1. Problem and outcome        2-4 sentences: who, what changes for them, how we will know
## 2. Scope                      In scope / Out of scope (bullets)
## 3. Requirements               R1, R2, ... one behaviour each, wording "must"
## 4. Acceptance criteria        AC1, AC2, ... see the acceptance-criteria skill; every R has at least one AC
## 5. Technical design           components touched, data changes, interfaces, failure handling
## 6. Risks and open points      anything the approver must decide
## 7. Traceability               table: R -> AC -> planned check (test file or manual step)
```

## Procedure

1. Read triage.md and CONTEXT.md. Use the repository's own terms (glossary, existing module names).
2. Write sections 1 and 2 first and keep them short. If scope is unclear, ask before going on.
3. Write requirements as observable behaviour, not implementation. One behaviour per requirement; split "and".
4. Write the technical design against the real code: name files, functions and tables you will change. Check they exist.
5. Fill the traceability table. A requirement with no check is not done; fix it or move it to open points.
6. Reread as the approver: could someone say yes or no to each line? Remove filler.

## Rules

- Never invent a business rule. If CONTEXT.md does not state it, it goes in Risks and open points or becomes a question.
- Keep the whole spec readable in five minutes. Link to references instead of pasting them.
- For a complete worked example read references/example-spec.md only when the work item is your first spec in a repository or the requester asked for the long form.

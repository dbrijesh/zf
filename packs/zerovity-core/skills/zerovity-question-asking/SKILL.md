---
name: zerovity-question-asking
description: Ask people good questions through result.json and stop. Use whenever information is missing, a decision is not yours to make, or a document is needed.
zerovity:
  version: 1.0.0
  phases: [INTENT, SPEC, BUILD, VERIFY, SHIP]
  consumes: [CONTEXT.md]
  produces: [result.json#questions]
  escalate: If the same question was already answered in CONTEXT.md, use the answer instead of asking again.
---

# Asking questions

You cannot talk to people directly. Questions travel through `result.json`, the foreman rewrites them into one message, and the answer comes back into your context.

## Before you ask

1. Search CONTEXT.md, the repository, linked tickets and prior answers. Ask only what remains.
2. Group related unknowns. Prefer three sharp questions to ten loose ones.
3. Never guess a business rule, a limit, a price, a legal or regulatory position.

## Writing a question

- `text`: one sentence that can be answered without opening anything else. Include the concrete case ("a $12,000 refund") instead of the abstract rule.
- `options`: give 2 to 4 options when the answer is a choice. Leave empty for open answers.
- `why`: say which part of your work is blocked and what you will do with each answer.
- `kind`: `decision` for a choice or fact. `context_request` when you need a document, file, link or data sample; name the exact thing ("the current reconciliation file layout").

## Finishing

1. Write `result.json` with `status: "needs_input"`, a two-sentence summary of what you did so far, and the questions.
2. Save partial work and commit it on the current branch.
3. Stop. Do not continue on an assumption and do not poll for the answer. You will be resumed in the same session.

## After the answer

Read the answer in CONTEXT.md under the question history. If it opens a new gap, ask once more; after two rounds on the same topic set `status: "blocked"` and say what a human must decide.

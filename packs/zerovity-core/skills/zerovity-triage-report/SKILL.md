---
name: zerovity-triage-report
description: Turn a raw request into a triage result with complexity, risk, gaps and a skip-spec decision. Use first in INTENT, before any spec or code is written.
zerovity:
  version: 1.0.0
  phases: [INTENT]
  consumes: [CONTEXT.md]
  produces: [triage.md, result.json#triage]
  escalate: Ask the requester when the goal, the affected system or the success measure cannot be found in context or code.
---

# Triage report

Goal: decide how much process this request needs and what is still unknown.

## Procedure

1. Restate the request in one sentence: who needs what, and why. If you cannot, that is gap number one.
2. Search the repository for the code the request touches. List the modules, entry points and tests you found. Note what you looked for and did not find.
3. Read every linked ticket, issue or document named in the request. Note contradictions between them.
4. Score the request:
   - **Complexity** S (one module, under 100 lines, no new concepts), M (several modules or one new concept), L (cross-service, migration, or new integration).
   - **Risk** high if it touches money, auth, personal data, regulated records, migrations, or public APIs; medium if it changes shared behaviour; low otherwise.
5. List gaps as questions. A gap is anything a developer would have to guess: a rule, a limit, an owner, an edge case, an acceptance measure.
6. Decide `skipSpec`. It may be true only when complexity is S, risk is low, and there are no gaps.
7. Write `.zerovity/out/triage.md` with sections: Summary, Evidence (files and links), Complexity and risk with one line of reasoning each, Gaps, Recommendation.
8. Put `triage` and `pathsTouched` (files you expect to change) in `result.json`.

## Rules

- Never raise `skipSpec` to save time. A wrong skip costs more than a short spec.
- Ground every claim in a file path or a link. Mark guesses as guesses.
- If gaps remain, set status `needs_input` and follow the question-asking skill.
- Keep the report under one page. Detail belongs in the spec.

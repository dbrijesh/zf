---
name: zerovity-adr-lite
description: Record a significant technical decision as a short architecture decision record in docs/adr. Use when a spec forces a choice between real alternatives or reverses an earlier decision.
zerovity:
  version: 1.0.0
  phases: [SPEC]
  consumes: [spec.md, CONTEXT.md]
  produces: [docs/adr/NNNN-title.md]
  escalate: Ask the approver when an accepted ADR in context conflicts with the design you need.
---

# ADR lite

Write an ADR only for a decision that is costly to reverse or that others will question later: data model shape, public interface, new dependency, security approach, build versus buy. Skip it for routine choices.

## Procedure

1. Search `docs/adr/` and CONTEXT.md for existing decisions on the topic. If an accepted ADR covers it, follow it and cite it; do not write a new one.
2. If your design conflicts with an accepted ADR, do not override it. Write the new ADR with status `Proposed`, say which ADR it would supersede, and raise it under Risks and open points in the spec.
3. Number the file with the next free four-digit number: `docs/adr/0007-short-title.md`.
4. Fill the template below. Keep it under 40 lines.
5. Link the ADR from the spec's technical design section.

## Template

```
# ADR 0007: <decision as a sentence>
Status: Proposed | Accepted | Superseded by 00NN
Date: YYYY-MM-DD
## Context      the forces and constraints, 3-6 lines
## Options      each option with one line of pros and cons (at least two)
## Decision     the choice and the main reason
## Consequences what becomes easier, what becomes harder, what we must watch
```

## Rules

- Status is always `Proposed` when written by an agent. A person accepts it.
- Name the rejected options honestly. An ADR with one option is documentation, not a decision.
- State facts about the code with file paths; state estimates as estimates.

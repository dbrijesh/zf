---
description: Judges whether a spec is complete, testable and traceable
labels: [pass, partial, fail]
passLabels: [pass]
sampling: 0.5
appliesTo:
  phases: [SPEC]
---

Score the spec produced in this run.

- pass: every requirement has at least one acceptance criterion with a named check, and no business rule is invented.
- partial: criteria exist but some are vague or untraceable.
- fail: requirements without criteria, or invented rules.

Return the label and two sentences of rationale.

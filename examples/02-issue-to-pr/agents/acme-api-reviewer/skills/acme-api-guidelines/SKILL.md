---
name: acme-api-guidelines
description: Check a change against Acme API conventions for naming, errors and versioning. Use when a diff adds or changes a public endpoint.
zerovity:
  version: 1.0.0
  phases: [VERIFY]
  consumes: [diff]
  produces: [api-review.md]
---

# Acme API guidelines

1. Resource names are plural nouns in kebab-case; actions are verbs only for non-CRUD commands.
2. Errors use the problem-details shape with a stable `code` field.
3. Breaking changes need a new version prefix; additive changes do not.
4. Money is integer minor units plus a currency code.
5. List endpoints are paginated with `limit` and `cursor`.

Report each violation with file, line and the rule number.

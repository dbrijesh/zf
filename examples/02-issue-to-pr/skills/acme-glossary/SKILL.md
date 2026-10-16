---
name: acme-glossary
description: Look up Acme payments terms (payout, settlement, PSP, SEPA return codes) before writing specs or reviews. Use when a term in the request is unfamiliar.
zerovity:
  version: 1.0.0
  phases: [INTENT, SPEC]
  consumes: [CONTEXT.md]
  produces: []
---

# Acme glossary

- **Payout**: money sent from Acme to a merchant bank account.
- **Settlement**: daily reconciliation of captured payments against PSP reports.
- **PSP**: payment service provider; external system that moves card money.
- **SEPA return code AC04**: the receiving account is closed; retrying cannot succeed.

When a term is not listed, ask; do not guess.

---
enabled: true
agent: foreman
triggers:
  - provider: github
    event: issue_labeled
    filter: { repos: [acme/payments-service], labels: [zerovity] }
---

Review the labeled issue and start it at the right phase.

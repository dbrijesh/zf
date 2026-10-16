---
enabled: false
agent: zerovity-researcher
triggers:
  - provider: schedule
    cron: "0 3 * * 1"
    name: weekly-dependency-audit
---

Audit dependencies for known advisories and open one work item per finding.

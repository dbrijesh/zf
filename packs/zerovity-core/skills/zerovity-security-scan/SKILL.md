---
name: zerovity-security-scan
description: "Check a diff for common security defects (secrets, injection, broken access control, unsafe data handling). Use in VERIFY when auth, input, secrets, money, personal data or dependencies change."
zerovity:
  version: 1.0.0
  phases: [VERIFY]
  consumes: [diff, CONTEXT.md]
  produces: [security.md, result.json#findings]
  escalate: Escalate any critical finding and any change to authentication or authorisation logic to a human owner.
---

# Security scan

Scan only what the change touches, plus the code it calls.

## Procedure

1. List changed files and tag each: input handling, auth, data access, secrets or config, dependencies, output rendering, file or network access.
2. Search the diff for secret shapes: private key headers, long random strings, assignments to names like `password`, `token`, `secret`, `key`. Any hit is `critical`.
3. For every tag, apply the matching check:
   - **Input handling**: all external input validated by type, length and format; no string-built SQL, shell commands, file paths or templates; use parameters.
   - **Auth**: every new route or action checks identity and permission on the server; no trust in client-provided roles or ids; object ownership verified.
   - **Data access**: queries scoped to the caller's tenant or owner; no `select *` of sensitive tables into responses.
   - **Output**: user content escaped for its context; no sensitive fields in logs, errors or analytics.
   - **Files and network**: paths normalised and confined; outbound calls use allowlisted hosts; TLS verification not disabled.
   - **Dependencies**: new packages named in the spec, pinned, and not obviously abandoned; no install scripts added without reason.
4. Apply the regulatory notes in CONTEXT.md (for example audit trail or e-signature rules). A missing audit entry for a regulated action is `high`.
5. Record each finding with severity, file, line and the safe alternative. Write `.zerovity/out/security.md` and add to result.json `findings`.

## Rules

- Report only what you can point at in the diff or its callers. No generic warnings.
- Do not run exploit code or touch real systems. Reason from the code and run existing tests.
- For the fuller checklist read references/owasp-checks.md only when the change adds an endpoint, a file upload, a deserialiser or a cryptographic operation.

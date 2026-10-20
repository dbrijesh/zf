# Code review (October 2026)

A review of the whole codebase with a focus on security, correctness under more than one instance, and the paths that were
run against live GitHub. Every finding below is fixed on the `dev` branch and has a regression test, unless it says otherwise.

## Security

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Critical | **Dev login signed in as any existing user by email alone.** With a public address (a tunnel) anyone who knew the administrator's email became the administrator. | The server refuses to start with dev login on a non-local `ZF_PUBLIC_URL` unless `ZF_ALLOW_PUBLIC_DEV_LOGIN=1`; dev login is rate limited (20 per minute per address). Use OIDC for anything shared. |
| 2 | High | **The GitHub token was stored in the clone's `.git/config`**, where the agent could read it (a write-capable token for every repository the App is installed on). | Clones use the clean URL; the token is passed to each git command through its environment, scoped to the remote's origin. A clone made by an older version is scrubbed on the next run. Agent git runs with the factory identity and none of the operator's git config or credential helpers. |
| 3 | High | **OIDC open redirect** (`next=//evil.example`), and **email-only account matching** (Entra ID's `email` claim is not verified). | `next` must be a plain same-site path. Unverified emails are rejected, an account linked to an IdP subject cannot be taken over by another identity with the same email, `OIDC_ALLOWED_DOMAINS` restricts who may sign in, and `OIDC_BOOTSTRAP_ADMIN` controls who becomes the first administrator. |
| 4 | Medium | **SSRF in URL context snapshots**: redirects were followed without re-checking, DNS could change between check and connect, and several IPv6 spellings of private addresses passed. | Every redirect hop is re-validated, the connection is pinned to the checked address, and IPv4-mapped / NAT64 / site-local / multicast ranges are blocked. |
| 5 | Medium | **Member removal ignored organisation boundaries**, and **changing a role overwrote every membership** of a person. | Removal is limited to the caller's organisation; a role change touches only the matching scope. |
| 6 | Medium | **Sessions could not be revoked.** | Sessions carry an issue time; `POST /auth/logout-all` and `POST /members/:id/revoke-sessions` end all earlier sessions. |
| 7 | Medium | GitHub webhook events were routed to every organisation's factories for that repository. | Events are limited to the organisation of the connection whose secret matched. |
| 8 | Low | Secrets were not bound to their location. | Ciphertext is bound to scope, id and name with AES-GCM additional data. Existing secrets still open and are upgraded when next written. |
| 9 | Low | `mcp.json` (with bearer tokens) was left in the working copy after a run; artifacts were served without a sandbox policy; no anti-framing headers. | Run files are an overlay that is restored before commit (see below); artifacts get `Content-Security-Policy: sandbox`; `X-Frame-Options`, `frame-ancestors`, HSTS and a permissions policy are set. |
| 10 | Low | URL fields in connection settings accepted any scheme. | Only `http(s)` is accepted. |

## Correctness and scale

| # | Finding | Fix |
|---|---|---|
| 11 | **Every run deleted the repository's own `.claude/skills`, `.agents/skills` and `.github/skills` folders** in the clone and the cleanup commit could remove them from the repository. | Skills and tool config are an overlay: what was there is restored before the commit, and a crashed run is recovered from a journal. |
| 12 | **Starting a worker failed every running run**, including runs healthy on other workers. | `reconcile` respects live job locks; it also runs from the periodic tick so truly orphaned runs are still cleaned up. The single embedded worker keeps the instant behaviour. |
| 13 | Duplicate work items for one source were possible (check-then-insert race; two API instances). | A unique index on open items per source, a migration that de-duplicates existing data, and the loser of a race returns the winner's item. |
| 14 | Schedules, connection checks and reminders ran on every API instance. | A database lease so one instance does that work at a time. |
| 15 | Agent commits were counted as human commits (autonomy metric wrong). | The agent runs git with the factory identity. |
| 16 | In Docker mode the non-root container user could not write the root-owned workspace. | The container runs as the worker's uid, or the tree is handed to uid 1000 when the worker is root. *(Docker path still untested here.)* |
| 17 | Trigger labels were compared case-sensitively against the definition. | Case-insensitive. |

## Not fixed (and why)
- **The local sandbox is not a security boundary.** The agent runs as the operator's user. Use the Docker sandbox for repositories you do not fully trust.
- **The egress proxy is a policy aid**, not a firewall; for a hard guarantee use an internal Docker network (`ZF_SANDBOX_NETWORK`).
- **`mammoth` (Word import) pulls in a dependency with a moderate advisory** (`sprintf-js`, denial of service through crafted format strings). File contents never reach a format string, so it is not reachable today. `npm audit fix` would downgrade `mammoth` to a version with worse advisories, so it is left alone.
- Docker killer in the Docker sandbox uses `pkill -f` by command name; precise but not process-group exact.
- A factory owner can define setup commands that run on the worker. That is by design: treat the role as privileged.

## Not reviewed in depth
The Jira client, the Codex and Copilot parsers beyond their fixtures, the scoring judges and most UI pages.
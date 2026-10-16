# Decisions

One short entry per choice the specification left open, or where this build deliberately differs from it. Newest at the bottom of each group. Questions the spec asks the owner (section 17) are answered at the end with the defaults that were used.

## Platform and tooling

**D-001 npm workspaces, no Turborepo.** The build machine had Node 24 and npm but no pnpm, git or Docker. npm workspaces give the same monorepo layout and shared types, run anywhere Node runs and need no extra tool. Scripts are plain npm scripts, so moving to pnpm + Turborepo later is a mechanical change (`workspaces` becomes `pnpm-workspace.yaml`).

**D-002 PGlite by default, Postgres with `DATABASE_URL`.** The product keeps exactly one stateful dependency: Postgres. Locally and for trials that dependency is PGlite (real Postgres compiled to WASM, same SQL dialect, same Drizzle schema and migrations), so `npm run dev` needs nothing installed. PGlite is single-process, so in that mode the worker runs inside the API process (`ZF_EMBED_WORKER`). With `DATABASE_URL=postgres://...` the API and worker are separate services (docker compose does this). Migrations are Drizzle SQL files in `packages/db/drizzle`.

**D-003 No compile step for Node packages.** Workspace packages export their TypeScript sources and run through `tsx`; Vite builds the web app. Type safety is enforced with `npm run typecheck` (strict mode, whole workspace). A bundled build for container images is a later optimisation.

**D-004 Postgres job queue instead of pg-boss.** The queue is a table claimed with `FOR UPDATE SKIP LOCKED` (the technique pg-boss uses), with singleton keys, retries, lock expiry and release. This runs unchanged on PGlite, which pg-boss cannot, and keeps tests hermetic.

**D-005 No Tailwind.** The approved Floor design is a complete hand-built system (tokens, cut corners, phase accents, grain, two themes). Its CSS is the design system: `packages/ui-kit/src/tokens.css` plus `apps/web/src/mock.css` and `app.css`. Re-expressing it as utility classes would add weight and risk drift.

**D-006 Live updates.** SSE streams a per-factory revision counter (stored in the database, bumped on every change, also emitted in-process for instant updates) and per-run events read from `run_events`. Clients refetch their queries on a revision change. This works across API and worker processes with no extra broker.

**D-007 Secrets envelope uses Node crypto.** AES-256-GCM per-secret data keys wrapped by a master key (`ZF_MASTER_KEY`, or a key file under the data dir for local use) instead of libsodium: same envelope design, no native dependency. Vault (HTTP) and AWS Secrets Manager (lazy SDK) providers are in `packages/db/src/secrets.ts`.

**D-008 Monaco pinned to 0.52.2.** `monaco-yaml` 5.x does not work with newer Monaco layouts (its worker fails with "Missing requestHandler"). Monaco and `monaco-yaml` are loaded on demand and fall back to a plain textarea if they cannot start.

## Orchestration

**D-009 State machine additions.** The spec's table is implemented as written plus: a `SHIP` state between `VERIFY` and `AWAITING_HANDOFF` (the spec names a shipper agent and the Floor has a SHIP lane); `AWAITING_GATE` for the extra gates that `riskOverrides` add (`buildApproval` after BUILD, `dbReview` after VERIFY, queued in order); `question_timeout` (NEEDS_INPUT to BLOCKED after twice `questionTimeoutHours`, with a reminder at one); `fatal` (to FAILED) and `retry` (BLOCKED back to the paused phase). `next(state, event, policy)` stays pure and has a full state-by-event matrix test.

**D-010 Foreman "ask first".** The advisor can return `askFirst` at intake. The foreman posts it to the thread but still starts INTENT, whose researcher asks through the normal question path. This avoids a pre-start waiting state that the spec's machine does not have.

**D-011 One clone per work item.** Each work item gets one normal clone on its branch, reused by every run, instead of a new worktree per run. Harness session resume depends on a stable working directory, and a self-contained `.git` also works inside a container. Skills and the `.zerovity/` folder are excluded from git through `.git/info/exclude`.

**D-012 Definition versions live in the database.** Every save of a UI-managed factory is a row in `definition_versions` (files, hash, validity, issues, author, message) rather than a commit in an internal git repository. History, diff, rollback and "invalid saves never apply" behave as specified; Git-backed factories use the real repository (read, sync on push, `zerovity/factory-config` check run, edits as PRs).

**D-013 `agentOverrides` and pack `include`.** To change a pack agent's harness, runner, credential or skills without forking it, `zerovity.factory.yaml` accepts `agentOverrides: { <agent>: { ... } }`. A pack entry may list `include: [skills]` so people can pick skills in the installer. Both are validated by the same schema.

**D-014 The `fake` harness.** An offline, deterministic harness (`packages/harness/fake`) runs the whole pipeline (sandbox, skills, context, result contract, usage, cost) without a model. It drives demos, the end-to-end tests and CI. `ZF_FORCE_HARNESS=fake` routes every agent to it. It is never chosen implicitly.

**D-015 Autonomy rate.** "Merged PRs with no human code push" is approximated by a `humanCommits` flag set when the worker finds commits by anyone other than the factory identity on the branch, or when the forge reports a push by a person.

## Integrations and runners

**D-016 Harness fixtures.** Claude Code was built against a real recording (version 2.1.300, see `packages/harness/claude-code/VERSION_NOTES.md`). Codex and Copilot CLI were not installed on the build machine, so their fixtures are hand-written from the documented event shapes and clearly marked synthetic; the parsers match event names loosely. Replace them with recordings (instructions in each `VERSION_NOTES.md`) on a machine that has the tools.

**D-017 Egress control.** Allowlist egress is a hostname-checking HTTP/CONNECT proxy the worker starts, with `HTTP(S)_PROXY` set in the container. It is a policy aid. For a hard guarantee attach sandboxes to an internal Docker network whose only route out is the proxy (`ZF_SANDBOX_NETWORK`). The container is still the real boundary: non-root, read-only root filesystem, no capabilities, no Docker socket, CPU and memory limits.

**D-018 Local sandbox on Windows.** The local (no container) sandbox runs `.exe` tools. A harness installed as an npm `.cmd` shim needs the Docker sandbox, WSL, or a native binary. The agent process only receives an allowlisted environment, never the worker's own secrets.

**D-019 MCP server.** Stateless streamable HTTP at `/mcp`, one server instance per request, authenticated by personal access token or session. Tool calls run as the caller and respect their roles per factory.

**D-020 Model prices.** The starter price table is approximate and shown with a warning in Settings. A cost reported by the harness always wins over the table.

## Not done in v1 (as in the spec)

`run_events` is not partitioned by month (a retention job is the next step); benchmarks, self-improvement PRs, Slack/Teams, GitLab/Azure DevOps and the Kubernetes runner backend are listed as "coming soon" or designed for through interfaces (`Forge`, `TrackerClient`, `Sandbox`).

## Answers to spec section 17

1. Multi-tenancy: one organisation per deployment; the schema carries `org_id` everywhere.
2. Gateway: separate service; the factory only needs base URLs (`gateway:` in the definition) and reads usage from harness output.
3. Copilot licensing: a service-account token by default (`Connections > GitHub Copilot token`); per-requester credentials can be added as another connection per agent.
4. First IdP: Entra ID through OIDC (any OIDC provider works).
5. E-signature: off by default; `reauthenticate: true` on a gate requires a fresh sign-in (or a confirmed email in dev mode) within five minutes.
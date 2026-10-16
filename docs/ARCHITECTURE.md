# Architecture

```
                 +---------------------- Web UI (apps/web, React) ----------------------+
                 | Floor | Inbox | Work item | Run (live) | Agents | Skills | Context   |
                 | Definition | Dashboard | Scorers | Connections | Settings            |
                 +--------------^-------------------------------^-----------------------+
                                | REST + SSE                    |
  Intake -------->  API (apps/api, Fastify + Zod, serves the web app)  <---- Factory MCP (/mcp) <--- local Claude Code / Codex / Copilot
  (GitHub App,       |  auth (OIDC / PAT), webhooks, OpenAPI, SSE
   Jira, web form,   v
   REST, MCP,     Orchestrator (packages/orchestrator)
   schedule,         |  state machine (pure) . policy engine . foreman advisor . context assembler
   webhook)          v
                  Postgres (jobs, work items, runs, run_events, audit_log, ...)  +  artifact store (fs | S3/MinIO)
                     v
                  Worker (apps/worker) --> Sandbox (Docker container per run, or local process)
                                              |  clone on the work item branch . skills materialised . .zerovity/context
                                              v
                                         Harness adapter --> claude / codex / copilot CLI (or the offline fake)
                                              |  JSONL
                                              v
                                         Normalised events --> run_events + SSE + usage + audit chain
```

## Packages

| Package | Job |
|---|---|
| `core` | IDs, errors, Zod schemas (result contract, events), secret redaction, token estimate |
| `audit` | Hash-chained entries and verification (`hash = sha256(prev + canonical_json(entry))`) |
| `db` | Drizzle schema + migrations, PGlite or Postgres, job queue, secrets envelope, artifact store, price table |
| `definition` | Factory-as-code: schemas, YAML/frontmatter parsing with line numbers, policy expression parser, validator, JSON Schemas |
| `skills` | Skill parser, linter (spec 7.2), layer resolver, packs and lockfile, per-harness materialiser, full validator |
| `context` | Context item model, assembler (layers, budgets, index, bundle hash), file conversion, URL snapshots |
| `harness/*` | Adapter interface and adapters for Claude Code, Codex, Copilot CLI, plus the offline `fake` |
| `forge/*`, `tracker` | Forge interface (GitHub App, local forge), Jira Cloud / Data Center client, webhook parsers |
| `orchestrator` | State machine, policy, advisor, definition service, context service, run planning, connections, intake, read models |
| `scoring` | Judges (heuristic and LLM) and deterministic sampling |
| `ui-kit` | Design tokens and shared React pieces |
| `apps/api` `worker` `web` `mcp` `cli` | The services and the `zf` command |

## Work item lifecycle

`INTAKE -> INTENT -> SPEC -> AWAITING_SPEC_APPROVAL -> BUILD -> VERIFY -> SHIP -> AWAITING_HANDOFF -> COMPLETE`, plus `NEEDS_INPUT`, `AWAITING_GATE`, `BLOCKED`, `FAILED`, `CANCELLED`. `next(state, event, policy)` returns the new state and a list of actions (`dispatchRun`, `createInbox`, `requestGate`, `postSource`, `openDraftPr`, ...). The `Orchestrator` service persists the state, writes an audit entry, and executes the actions. Gates are data (`policies/gates.yaml`): the spec gate, risk-based extra gates and the handoff.

## Run lifecycle

1. `enqueueRun` checks the budget, resolves the agent (factory agent, else pack agent, plus `agentOverrides`), inserts a `runs` row and a job.
2. A worker claims the job and asks `canStart` (factory and repository concurrency, paused factories).
3. `prepareRun` builds the **RunPlan**: effective skills, preamble, phase prompt (with answers, review comments or findings when resuming), context inputs, resolved secrets (only what the agent declared), gateway URLs, MCP servers, limits, and the session to resume.
4. `executeRun` prepares the clone and branch, writes skills where the harness reads them, assembles `.zerovity/context/CONTEXT.md` (recording the bundle hash), starts the harness in the sandbox, normalises its output, records events and usage live, enforces time, idle and budget limits, and watches for stop requests and follow-up messages.
5. The agent must write `.zerovity/out/result.json`. If it is missing or invalid and the harness exited cleanly, one repair follow-up is sent in the same session; otherwise the run fails with `no_result`.
6. The worker uploads outputs, commits leftovers as `[zerovity:<agent>]`, pushes the branch, stores the diff and finishes the run. `finishRun` turns the result into a machine event.

## Audit

Every transition, advisor decision, run start and end, gate decision, definition change, context change, connection change and secret write is an `audit_log` row in a per-factory hash chain. The table is append-only (a trigger rejects `UPDATE` and `DELETE`; production should also grant the application role INSERT and SELECT only). `zf audit verify`, `GET /factories/:id/audit/verify` and the Audit tab verify the chain; export is JSONL or CSV. Gate decisions store the user, time, reason and the hash of what was approved (the spec text, or the diff plus result).

## Security notes

Sandboxes are non-root with a read-only root filesystem, no capabilities and no Docker socket. Credentials are injected as environment variables for the run and never written to the worktree; each agent receives only the secrets and MCP servers it declares. Events are redacted (token patterns and high-entropy strings) before storage. The GitHub App requests contents, pull requests, issues, checks and metadata only, and agents are told (and the harness commands are configured) never to push, merge or change remotes; the worker pushes branches. Enable branch protection so merging always needs a person.
# Zerovity Factory: capabilities

A self-hosted software factory. A team of AI agents works on your repositories, people approve at defined gates, and the result is a pull request with evidence. **Agents never merge.**

Items marked *(not tested live)* are built and covered by automated tests with mocked services, but have not been run against the real service yet.

## How work flows
- Work moves through five phases: **Intent, Spec, Build, Verify, Ship**, then a human **handoff**.
- A foreman decides where each item starts (simple items can skip the spec) and moves it along.
- The foreman uses rules by default, or a small Claude model when an advisor key is set.
- Agents can stop and ask a question; the item waits in the Inbox until someone answers.
- Agents can ask for more context; people answer or attach files.
- Changes requested at a gate go back to the same agent, in the same session.
- Failed or blocked items can be retried; running items can be stopped or cancelled.
- A factory can be paused. Limits cap concurrent runs and runs per repository.
- Time limit, idle limit, token budget and cost budget per run and per work item.
- One clone and one branch per work item (`zerovity/zf-N-...`), reused across runs so sessions resume.
- Draft pull request opened early, marked ready for review at handoff. The factory never merges.
- Progress is posted back to the source issue or ticket.

## Gates and approvals
- Spec approval gate, plus a final handoff gate.
- Extra gates by risk: build approval, database review, and others, set in `gates.yaml`.
- Approve, request changes with inline comments, or reject.
- Optional re-authentication before a gate decision.
- Every decision records who, when, why, and a hash of what was approved.

## Where work comes from (intake)
- GitHub issue label (default `zerovity`), issue comments and mentions.
- GitHub pull request events, reviews and comments.
- Jira Cloud and Jira Data Center ticket labels and comments *(not tested live)*.
- Web composer in the UI.
- REST API.
- Inbound webhooks with secret and rotation.
- Schedules (cron).
- Local coding agents through the factory MCP server.
- Factory-triggered follow-up work items.

## Agents
- Five default agents: **researcher, spec-writer, executor, verifier, shipper**.
- Each agent is a small markdown file with front matter (phase, harness, model, skills, outputs).
- Add your own agents, or override a pack agent without forking it (harness, model, runner, skills, MCP servers).
- Changing an agent's harness resets the model to the factory default.
- Agents declare the secrets and MCP servers they may use, and get only those.
- Agent test run from the UI with a sample request.

## Harnesses (the coding agent CLIs)
- **Claude Code**: verified against a real recorded session and real runs.
- **OpenAI Codex CLI** *(synthetic fixtures; not tested live)*.
- **GitHub Copilot CLI** *(synthetic fixtures; not tested live)*.
- **Cursor CLI** (`agent`) *(written from the official docs; synthetic fixtures; not tested live)*: headless runs with skills in `.cursor/skills`, MCP and permission config per run, session resume, API key connection. Cursor reports no token counts, so its usage is estimated from text size.
- Offline **fake** harness for demos, tests and CI; no model needed.
- Per-agent model and reasoning level, with factory defaults.
- Usage, cost and cached tokens captured per run; a harness-reported cost wins over the price table.
- Result contract: every run must write `result.json`; one automatic repair attempt if it is missing or invalid.
- Session resume for follow-ups and revisions.

## Skills and packs
- 14 light, reusable skills in the `zerovity-core` pack (each under 150 lines).
- Skills are written once and placed where each harness expects them.
- Skill linter with the lightness rules; shows always-loaded and on-demand token cost.
- Layered precedence: agent-private, then factory, then pack.
- Skills library in the UI: browse, edit, create, fork pack skills, delete, live lint.
- Packs: install from a folder, tarball or registry; pick which skills to include; lockfile with hashes; diff.
- Pack `include:` list and `agentOverrides` in the factory file.

## Context (giving the factory knowledge)
- Context library with items at factory, repository, agent and work-item level.
- Notes, glossaries, decision records, repository pointers, URLs, files and tickets.
- File upload with conversion to text; URL snapshots with protection against internal-network access.
- Context is assembled in a fixed order within token budgets, with an index and a bundle hash recorded on every run.
- Repository convention files (`AGENTS.md`, `CLAUDE.md`) are included automatically.
- Answers and attached files flow back into the next run.

## Factory as code (definition)
- A factory is a folder of YAML and markdown files: factory, agents, skills, runners, gates, scorers, context, automations.
- Strict validation with file and line errors, cross-reference checks, secret detection and policy-expression checks.
- An invalid save never takes effect; the last valid definition stays active.
- Definition editor in the UI (Monaco) with schema help, history, diff and rollback.
- Git-backed definitions with sync on push and a `zerovity/factory-config` check on pull requests *(not tested live)*.
- JSON Schemas published for every file type.
- Example factories included (single repo, issue to PR).

## Running agents safely
- Local sandbox, or a Docker sandbox per run *(Docker path not tested here)*.
- Containers run as non-root, read-only root, no extra capabilities, no Docker socket, with CPU and memory limits.
- Egress allowlist proxy per runner.
- The agent process only receives an allowlisted environment, never the server's own secrets.
- Runner definitions: image, setup commands, resources, network allowlist.
- Setup commands run before the agent starts.
- Credentials injected per run only, never written into the worktree.
- Secret redaction on all stored events.
- Git credentials are never written into the working copy; agents run git with the factory identity and none of the operator's git configuration.
- Skills and tool config are placed for one run only and removed before the commit, restoring any file the repository already had there.

## Connections and secrets
- GitHub App and GitHub token connections; installation tokens are short-lived.
- Jira Cloud (OAuth) and Jira Data Center (token) connections *(not tested live)*.
- Anthropic, OpenAI, Copilot and Cursor credentials; MCP HTTP servers; package registry; OIDC.
- Test, rotate and health status on every connection.
- Secrets encrypted with AES-256-GCM envelope encryption; shown only as the last four characters.
- Vault and AWS Secrets Manager providers *(not tested live)*.
- Webhook delivery log showing accepted and rejected deliveries and why.

## Live visibility (UI)
- **Floor**: the whole pipeline at a glance, smooth with 200+ items.
- **Inbox**: questions and gates, keyboard navigation, resolve with undo.
- **Work item**: conversation, timeline, spec review, changes, evidence, context, audit.
- **Run page**: live events over SSE, token and cost ticker, stop button, send a follow-up, download transcript.
- Shows the step currently running and how long it has been running.
- **Agents**, **Skills**, **Context**, **Definition**, **Connections**, **Settings** pages.
- **Dashboard**: runs, cost, throughput, autonomy rate, quality scores.
- **Scorers**: automatic quality scoring of specs and results (heuristic and model-based judges, sampled).
- Command palette (Ctrl/Cmd+K), light, dark and slate themes, accessible landmarks and labels.

## Cost control
- Token and cost budgets per run and per work item; runs stop when exceeded.
- Spend tracked live on the Floor and in the Dashboard.
- Editable model price table (defaults are approximate).

## Security and audit
- Sign-in with OIDC (Entra ID, Okta, Keycloak) or dev login for trials. Dev login refuses to start on a public address unless explicitly allowed. OIDC can restrict email domains and the first administrator, and binds accounts to the identity provider's subject.
- Sessions can be ended: sign out everywhere, or an administrator ends a person's sessions.
- Roles: org admin, factory owner, approver, member, viewer.
- Personal access tokens for the API, CLI and MCP.
- Signed session cookies; webhook signature verification (GitHub) and shared secrets (Jira, inbound).
- Tamper-evident audit log: every action is in a SHA-256 hash chain; the table is append-only.
- Verify the chain from the CLI or API; export as JSONL or CSV.

## Integrations for developers
- REST API with generated OpenAPI at `/api/v1/openapi.json`.
- Factory MCP server at `/mcp` with 12 tools (send a task, get a task, add context, validate a definition, and more) so local Claude Code, Codex or Copilot can use the factory.
- Live event streams (SSE) per factory and per run.

## Command line: `zf`
- `zf validate` (file:line errors, `--json`, `--weights`).
- `zf skills lint`.
- `zf pack list`, `install` (animated picker), `lock`, `bundle`.
- `zf run` to run one agent locally without a server.
- `zf login`, `factories`, `send`, `tasks`.
- `zf audit verify` and `export`.
- `zf schema` and `zf doctor`.

## Deploy and operate
- One command local trial with an embedded database (no Postgres needed).
- Postgres, MinIO or S3 artifact storage, separate API and worker services for production.
- Safe with several API instances and workers: a database lease for periodic work, a unique index against duplicate work items, and worker start-up that never fails other workers' runs.
- Docker Compose file, API and worker image, runner base image, `.env.example`, CI workflow.
- Health endpoint and container health checks.
- Works behind a tunnel (Cloudflare Tunnel, ngrok) for webhooks without a static IP.

## Known limits
- Docker sandbox, GitHub and Jira live flows, OIDC, S3 and Postgres worker mode were not exercised against real services here.
- Codex and Copilot adapters use synthetic fixtures until real recordings replace them.
- Model prices are placeholders; benchmarks, Slack/Teams, GitLab and Kubernetes runners are not built.
- Repositories removed from a definition are not removed from the factory's repository list.

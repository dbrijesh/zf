# Zerovity Factory — Build Specification

Version 0.1 · October 2026 · Owner: Brijesh (Hexaware DnS, RapidX / Zerovity platform)

---

## 0. How to use this spec (instructions for Claude Code)

You are building a self-hostable software factory product called **Zerovity Factory**. Read this whole file before writing code.

Working rules:

1. Build in the milestone order in section 15. Finish each milestone's acceptance checks before starting the next one. Commit at the end of each milestone with a message `M<n>: <title>`.
2. Before writing a harness adapter (section 8), check the current CLI help and docs for that tool (`claude --help`, `codex exec --help`, `copilot --help`) and adjust flags to what is actually installed. The flags in this spec were correct when written, but these CLIs change often. Record the version you built against in `packages/harness/<tool>/VERSION_NOTES.md`.
3. Keep a running `docs/DECISIONS.md` with one short entry for each design choice you make that this spec leaves open.
4. Write tests as you go. Every package needs unit tests. The orchestrator state machine needs exhaustive transition tests.
5. When something in this spec is ambiguous, pick the simplest option that keeps the product self-hostable, note it in `DECISIONS.md`, and keep going. Stop and ask only when a choice would be expensive to undo (database schema shape, public file formats).
6. Never put secrets in the repo, in logs, or in event payloads.

---

## 1. What we are building

A factory is a team of agents attached to one or more repositories. Work comes in (a GitHub issue, a Jira ticket, a form in the web UI, a call from a local coding agent). A coordinator moves each work item through Zerovity's phases, dispatches the right agent for each phase, stops for a human at defined gates, and ends by handing a pull request with evidence to a person. Agents never merge.

Three things matter most to the owner, and they shape every design decision below:

1. **Agents and skills stay small and reusable.** An agent is a short role file plus a list of skills. A skill is a short procedure with declared inputs and outputs. The same skill works in Claude Code, Codex and GitHub Copilot CLI.
2. **Users can give the factory more context, easily and at any level.** Organisation standards, repository conventions, glossaries, ADRs, uploaded documents, links, and answers to agent questions all flow into the agents through one context system, with a preview of exactly what an agent will see.
3. **A strong web UI runs the whole thing.** People watch work move, answer questions, approve specs, edit agents and skills, attach context and read costs from one place.

Version 1 supports three harnesses: **Claude Code**, **OpenAI Codex CLI** and **GitHub Copilot CLI**.

### 1.1 Reference model

The design borrows the shape of Warp Factories (foreman, stage agents, work items, inbox, factory-as-code, scorers, Factory MCP). Zerovity Factory differs in four ways that matter for our clients in pharma, financial services and medical devices:

- It runs entirely on infrastructure the client controls (laptop, VM, Kubernetes). No hosted control plane is required.
- The coordinator is a deterministic state machine with an LLM advisor. Routing decisions are logged and replayable, which auditors can follow.
- Every event goes into an append-only, hash-chained audit log, and approvals capture identity, time and a reason.
- Token and cost data is captured per run, per work item and per agent from day one, and model traffic can route through a Zerovity gateway.

### 1.2 Out of scope for v1

- Running agents on macOS or Windows runners (Linux containers only).
- GitLab and Azure DevOps runtime support (the Connections screen lists them as "coming soon"; design the forge interface so they can be added).
- Slack and Teams intake (same: listed in Connections, built later). GitHub and Jira are in v1 (M7).
- Benchmarks across configurations (scorers are in; benchmarks are M10+).
- Self-improvement that opens PRs against the factory definition (design the hooks, build later).

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| Factory | One configured instance: repositories + agents + skills + context + policies. A deployment can host many factories. |
| Work item | One request the factory acts on. Keeps one ID from intake to completion. |
| Phase | A step in the lifecycle. Zerovity phases: INTENT, SPEC, BUILD, VERIFY, SHIP. (OPERATE arrives through automations later.) |
| Stage agent | The agent that works a phase, e.g. `zerovity-spec-writer` works SPEC. |
| Foreman | The coordinator for a work item. In this product it is the orchestrator service plus an LLM advisor call. It is the only thing that talks to the requester. |
| Run | One execution of one agent through one harness in one sandbox. A work item has many runs. |
| Harness | The coding tool that executes a run: `claude-code`, `codex`, `copilot`. |
| Skill | A folder with `SKILL.md` and optional `references/` and `scripts/`. A reusable procedure. |
| Skill pack | A versioned bundle of skills (and optionally agents) that can be installed into many factories. |
| Context item | A piece of user-supplied knowledge: note, file, URL snapshot, glossary entry, ADR, repo path pointer. |
| Gate | A point where the work item waits for a human decision. |
| Inbox item | Something waiting on a specific person: a question, a spec approval, a PR review, a blocked or failed run, a context request. |
| Runner | The container image and resource shape a run executes in. |
| Scorer | An LLM judge that classifies completed runs against a rubric. |

---

## 3. System overview

```
                 ┌──────────────────────── Web UI (apps/web) ────────────────────────┐
                 │ Floor · Inbox · Work item · Runs (live) · Agents · Skills ·       │
                 │ Context · Definition editor · Dashboard · Scorers · Settings      │
                 └───────────────▲───────────────────────────────▲───────────────────┘
                                 │ REST + SSE                    │
 Intake ─────────►  API server (apps/api)  ◄──── Factory MCP server (apps/mcp) ◄── local Claude Code / Codex / Copilot
 (GitHub App,       │  auth, REST, SSE, webhooks
  web form,         ▼
  REST, MCP,     Orchestrator (packages/orchestrator)
  schedule)         │  state machine · policy engine · foreman advisor · context assembler
                    ▼
                 Job queue (pg-boss on Postgres)
                    ▼
                 Worker (apps/worker) ──► Sandbox (Docker container per run)
                                              │  git worktree · materialised skills · CONTEXT.md
                                              ▼
                                         Harness adapter → claude / codex / copilot CLI
                                              │  JSONL event stream
                                              ▼
                                         Event normaliser → events table + SSE + usage + audit chain
```

Everything runs from one `docker compose up` for local and pilot use. A Helm chart is a later deliverable; keep services stateless apart from Postgres and the artifact store so the chart is easy.

---

## 4. Technology choices

Use these unless you hit a hard blocker (record any change in `DECISIONS.md`).

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere, Node 22 LTS | One language across UI, API, worker, MCP and CLI |
| Monorepo | pnpm workspaces + Turborepo | Fast builds, shared types |
| API | Fastify + Zod + `fastify-type-provider-zod` | Typed routes, schema reuse |
| DB | PostgreSQL 16 + Drizzle ORM + drizzle-kit migrations | Single stateful dependency |
| Queue | pg-boss (on the same Postgres) | Avoids adding Redis; good enough for factory throughput |
| Live updates | Server-Sent Events | One-way stream is all the UI needs; works through proxies |
| Artifact store | Local filesystem in dev, S3-compatible (MinIO in compose) in deploy | Logs, transcripts, screenshots, uploaded context files |
| Sandboxes | Docker Engine API via `dockerode` | Per-run isolation; Kubernetes Jobs backend later behind the same interface |
| Web | React 19 + Vite + TanStack Router + TanStack Query + Tailwind CSS v4 | Fast SPA served by the API in production |
| UI pieces | Radix primitives (headless), Monaco editor, Motion for animation, visx or D3 for the floor and charts | Full control over look; no stock dashboard template |
| Auth | OIDC (Entra ID, Okta, Keycloak) via `openid-client`; a local dev login | Enterprise clients bring their own IdP |
| Secrets | Envelope encryption in Postgres (libsodium, master key from env or KMS) with a pluggable external provider (Vault, AWS Secrets Manager) | Self-hosted by default |
| MCP | `@modelcontextprotocol/sdk`, streamable HTTP transport | Same server for any MCP client |
| CLI | `zf` built with `commander` + `ink` for the animated installer | Matches the RapidX installer direction |
| Tests | Vitest, Playwright for UI e2e, testcontainers for Postgres | |

---

## 5. Repository layout

```
zerovity-factory/
  apps/
    api/            Fastify server, REST, SSE, webhooks, serves the built web app
    worker/         pulls jobs, prepares sandboxes, runs harness adapters
    web/            React SPA
    mcp/            Factory MCP server
    cli/            `zf` CLI (validate, lint, install packs, run locally, send tasks)
  packages/
    core/           shared types, Zod schemas, IDs, errors
    db/             Drizzle schema, migrations, repositories
    definition/     factory-as-code loader, JSON Schemas, validator, resolver
    skills/         skill parser, linter, pack resolver, per-harness materialiser
    context/        context items, assembly engine, token counting
    orchestrator/   state machine, policy engine, foreman advisor, dispatcher
    harness/
      common/       adapter interface, normalised event types, usage parsing
      claude-code/
      codex/
      copilot/
    forge/
      common/       forge interface
      github/       GitHub App: webhooks, branches, PRs, comments, checks
    audit/          hash-chained event log, verification
    scoring/        scorer runner
    ui-kit/         design tokens and shared React components
  packs/
    zerovity-core/  default agents and skills shipped with the product (section 7)
  examples/
    01-single-repo/
    02-issue-to-pr/
  docker/
    runner-base/    base image for sandboxes (git, node, python, the three CLIs)
  docs/
    DECISIONS.md
    ARCHITECTURE.md
```

---

## 6. Factory definition as code

A factory is defined by a folder of YAML and Markdown files. It can live in Zerovity's own storage (edited in the web UI, every save is a commit in an internal git repo) or in a Git repository the team owns (changes arrive by PR, a status check validates them). Both use the same format. Resource names come from paths.

```
zerovity.factory.yaml
agents/
  <name>/agent.md
  <name>/skills/<skill>/SKILL.md        # skills only this agent can load
skills/
  <skill>/SKILL.md                      # skills every agent in the factory can load
context/
  <name>.md | <name>.yaml               # factory-level context items (section 9)
automations/
  <name>/automation.md
runners/
  <name>.yaml
scorers/
  <name>/scorer.md
policies/
  gates.yaml
zerovity.lock                           # resolved skill pack versions
```

### 6.1 `zerovity.factory.yaml`

```yaml
schemaVersion: zf/v1alpha1
name: payments-factory
alias: payments                 # handle used in GitHub comments: @zerovity payments
description: Handles approved work for the payments service
repositories:
  - forge: github
    owner: acme
    name: payments-service
    defaultBranch: main
packs:                          # skill packs to install, resolved into zerovity.lock
  - name: zerovity-core
    version: ^1.0.0
  - name: acme-standards        # an org pack from the Skill Library
    version: ^2.3.0
agentDefaults:
  harness:
    type: claude-code           # claude-code | codex | copilot
    model: claude-sonnet-4-5    # whatever the harness accepts
    reasoning: medium           # optional, mapped per harness
  runner: node-default
  idleTimeoutMinutes: 10
  maxRunMinutes: 60
  budget:
    maxTokensPerRun: 2000000
    maxCostPerWorkItemUsd: 25
gateway:                        # optional: route model calls through a Zerovity gateway
  anthropicBaseUrl: ${secret:ZEROVITY_GATEWAY_ANTHROPIC_URL}
  openaiBaseUrl: ${secret:ZEROVITY_GATEWAY_OPENAI_URL}
secrets: [GITHUB_APP_KEY]
mcpServers:
  jira:
    url: https://mcp.example.com/jira
    headers: { Authorization: "Bearer ${secret:JIRA_MCP_TOKEN}" }
```

Rules:
- Unknown keys are errors.
- `${secret:NAME}` is the only way to reference a secret. The resolver injects values at run time into the sandbox environment; they never appear in the stored definition, events or logs.
- `agentDefaults.harness` can be overridden per agent and per automation.

### 6.2 `agents/<name>/agent.md`

Keep agent files short. The body says what the role is responsible for and when to stop. Procedures belong in skills.

```markdown
---
description: Turns a triaged work item into a product + technical spec with validation criteria
phase: SPEC                     # INTENT | SPEC | BUILD | VERIFY | SHIP | CUSTOM
role: spec-writer
skills:                         # skills this agent loads; resolved from agent, factory and packs
  - zerovity-spec-format
  - zerovity-acceptance-criteria
  - acme-api-guidelines
contextScopes: [org, factory, repo, workItem]   # which context layers to assemble (section 9)
harness:                        # optional override
  type: codex
  model: gpt-5-codex
outputs: [spec.md]              # files this agent must produce in .zerovity/out/
spawnableBy: [foreman]
---

You write the spec for one work item. Read the triage result and CONTEXT.md first.
Produce spec.md using the zerovity-spec-format skill. Every requirement needs a
validation criterion a reviewer can check.

If anything in the request is unclear, ask through the result file (section 8.4) and stop.
Do not write production code.
```

Size limits enforced by the linter: body ≤ 60 lines; description ≤ 200 characters.

### 6.3 `policies/gates.yaml`

Gates are data, so a client can tighten them without editing prompts.

```yaml
gates:
  specApproval:
    when: phase_completed
    phase: SPEC
    required: true
    approvers: { groups: [tech-leads] }
    requireReason: false
  questionTimeoutHours: 48          # unanswered questions raise a reminder, then mark BLOCKED
  handoff:
    required: true                  # the factory always ends with a person
  riskOverrides:                    # extra gates based on triage output
    - if: triage.risk == "high"
      add: [buildApproval]
    - if: paths.touched matches "migrations/**"
      add: [dbReview]
merge:
  agentsMayMerge: false             # hard rule; also enforce with branch protection
```

### 6.4 `automations/<name>/automation.md`

```markdown
---
enabled: true
agent: foreman
triggers:
  - provider: github
    event: issue_labeled
    filter: { repos: [acme/payments-service], labels: [zerovity] }
  - provider: schedule
    cron: "0 3 * * 1"
    name: weekly-dependency-audit
---
Review the labeled issue and start it at the right phase.
```

v1 providers: `github` (`issue_labeled`, `issue_commented`, `issue_mentioned`, `pull_request_commented`, `check_suite_completed`), `schedule`, `webhook` (authenticated JSON POST), `factory` (`work_item_phase_changed`).

### 6.5 `runners/<name>.yaml`

```yaml
description: Node 20 with pnpm
image: ghcr.io/hexaware/zerovity-runner-node:20
setupCommands: [corepack enable, pnpm install --frozen-lockfile]
resources: { cpus: 4, memoryGb: 8 }
network:
  egress: allowlist
  allow: [registry.npmjs.org, github.com, api.anthropic.com, api.openai.com, api.githubcopilot.com]
```

### 6.6 Validation

- Publish JSON Schemas for every file type from `packages/definition/schemas/` and serve them at `/api/v1/schemas/zf/v1alpha1/<doc>.json`.
- `zf validate <path>` checks syntax, cross-file references (agents named in automations exist, skills named in agents resolve, runners exist, secrets are declared), skill lint rules and policy expressions. Errors report file and line.
- A GitHub check run `zerovity/factory-config` runs the same validator on PRs to a definition repo.
- The definition is applied as one unit. If validation fails, the factory keeps its last valid definition.

---

## 7. Agents and skills: keeping them small and reusable

### 7.1 Skill format

Use the open `SKILL.md` format (YAML frontmatter + Markdown body) so the same file works in all three harnesses. Add Zerovity metadata under one key so other tools ignore it.

```markdown
---
name: zerovity-acceptance-criteria
description: Write testable acceptance criteria for a requirement. Use when drafting or reviewing a spec.
zerovity:
  version: 1.2.0
  phases: [SPEC, VERIFY]
  consumes: [triage.json, CONTEXT.md]
  produces: [spec.md#acceptance-criteria]
  escalate: Ask the requester when a criterion depends on a business rule not found in context.
---

# Acceptance criteria

1. One criterion per observable behaviour. Use Given / When / Then.
2. Each criterion names how it will be checked: unit test, integration test, screenshot, manual.
3. ...

For edge-case checklists by domain, read references/edge-cases.md only when the spec covers payments or PII.
```

### 7.2 Lightness rules (enforced by `zf skills lint`)

| Rule | Limit |
|---|---|
| `SKILL.md` body | ≤ 150 lines and ≤ 2,000 tokens |
| `description` | ≤ 300 characters, must say when to use the skill |
| One job per skill | Lint warns when a skill declares more than 3 `produces` entries |
| Large material | Goes in `references/*.md`, loaded on demand; the body must name when to read each reference |
| Scripts | `scripts/` allowed; must be executable, documented in the body, and have no network calls unless declared in `zerovity.network: true` |
| No secrets, no absolute paths, no harness-specific tool names in the body | Lint errors |

The linter also reports a token cost per skill and per agent (sum of the agent body and the always-loaded skill descriptions) so authors can see the weight they add.

### 7.3 Resolution and overrides

When a run starts, the skill set for its agent is resolved in this order, later entries winning on name clashes:

1. Pack skills (in `packs:` order)
2. Factory skills (`skills/`)
3. Agent skills (`agents/<name>/skills/`)

An override must keep the same `name`. The UI shows the effective skill set for each agent and marks which layer each skill came from.

### 7.4 Skill packs

- A pack is a folder or tarball with `pack.yaml` (`name`, `version`, `description`, `skills/`, optional `agents/`).
- Packs live in the Skill Library: a registry inside Zerovity (Postgres + artifact store), with import from a Git URL or tarball.
- `zerovity.lock` pins exact versions and content hashes. Upgrading a pack is an explicit action that produces a diff in the UI.
- `zf pack install <name>` runs an animated `ink` installer that lists available packs and lets the user pick which skills to include, matching the RapidX installer direction.

### 7.5 Materialising skills per harness

The worker writes the resolved skills into the run's worktree under the path each harness reads. Put this mapping in one table in `packages/skills/src/materialise.ts` and verify each path against current docs during M3.

| Harness | Skill location in worktree (verify) | Instructions delivery |
|---|---|---|
| claude-code | `.claude/skills/<name>/SKILL.md` | `--append-system-prompt-file` or `--append-system-prompt` with the agent body + run preamble |
| codex | `.agents/skills/<name>/SKILL.md` (check current Codex skills path) | Prepend agent body + run preamble to the prompt passed to `codex exec` |
| copilot | `.github/skills/<name>/SKILL.md` (check current Copilot CLI skills path; fall back to `.claude/skills/` if Copilot reads it) | Prepend to the `-p` prompt; optionally emit a custom agent file if the CLI supports `--agent` |

Materialised files are added to `.git/info/exclude` in the worktree so they never get committed. The repo's own `AGENTS.md`, `CLAUDE.md` and `.github/copilot-instructions.md` are left alone and still apply.

### 7.6 Default pack: `zerovity-core`

Ship a small default team. Names follow the existing Zerovity convention (lowercase, hyphenated, `zerovity-` prefix in client-facing material). Each agent stays under the size limits; the depth lives in skills.

| Agent | Phase | Job | Key skills |
|---|---|---|---|
| zerovity-researcher | INTENT | Read the request, search the code and linked tickets, reproduce when needed, list gaps, ask the requester questions until the story is complete | `zerovity-triage-report`, `zerovity-question-asking`, `zerovity-repro` |
| zerovity-spec-writer | SPEC | Product + technical spec with validation criteria, as a draft PR on a branch | `zerovity-spec-format`, `zerovity-acceptance-criteria`, `zerovity-adr-lite` |
| zerovity-executor | BUILD | Implement on the spec branch, add tests, run repo validation, attach evidence | `zerovity-tdd-loop`, `zerovity-repo-validation`, `zerovity-evidence-capture` |
| zerovity-verifier | VERIFY | Independent check against spec, tests, conventions and security; recommend accept, revise, or escalate | `zerovity-review-checklist`, `zerovity-security-scan`, `zerovity-test-gap` |
| zerovity-shipper | SHIP | Final PR description, changelog entry, evidence bundle, link back to source | `zerovity-pr-handoff`, `zerovity-evidence-bundle` |

Default harness mapping, editable per factory: researcher and spec-writer on Claude Code, executor on Codex, verifier on a different harness or model from the executor (so they do not share blind spots), shipper on the cheapest capable model.

Write each skill properly (real procedures, ≤ 150 lines). These are the product's first impression.

---

## 8. Harness adapters

### 8.1 Interface

```ts
// packages/harness/common/src/types.ts
export type HarnessType = 'claude-code' | 'codex' | 'copilot';

export interface RunSpec {
  runId: string;
  workItemId: string;
  agent: ResolvedAgent;              // body, skills, outputs, harness config
  prompt: string;                    // phase prompt built by the orchestrator
  worktreePath: string;              // inside the sandbox
  env: Record<string, string>;       // resolved secrets + gateway URLs
  mcpConfigPath?: string;            // generated per run
  resumeSessionId?: string;          // continue the same agent conversation
  limits: { maxMinutes: number; maxTokens: number };
}

export interface HarnessAdapter {
  type: HarnessType;
  detect(): Promise<{ installed: boolean; version?: string }>;
  buildCommand(spec: RunSpec): { cmd: string; args: string[]; env: Record<string, string> };
  parseLine(line: string): NormalisedEvent[];      // one stdout line → zero or more events
  extractSessionId(events: NormalisedEvent[]): string | undefined;
  extractUsage(events: NormalisedEvent[]): Usage;  // tokens in/out/cached, cost if reported
  sendFollowUp?(sessionId: string, message: string, spec: RunSpec): ReturnType<HarnessAdapter['buildCommand']>;
}

export type NormalisedEvent =
  | { kind: 'session.started'; sessionId: string; model?: string }
  | { kind: 'message.assistant'; text: string }
  | { kind: 'tool.call'; tool: string; input: unknown; id: string }
  | { kind: 'tool.result'; id: string; ok: boolean; summary: string }
  | { kind: 'file.changed'; path: string; op: 'add' | 'modify' | 'delete' }
  | { kind: 'command.run'; command: string; exitCode?: number }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number }
  | { kind: 'error'; message: string }
  | { kind: 'session.ended'; status: 'success' | 'error' | 'timeout' | 'cancelled' };
```

### 8.2 Starting command lines (verify each during M3)

**Claude Code**

```
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --append-system-prompt-file .zerovity/run/INSTRUCTIONS.md \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Write,Grep,Glob,Bash(git *),Bash(pnpm *),Bash(npm *)" \
  --mcp-config .zerovity/run/mcp.json \
  --model <model> \
  [--resume <sessionId>]
```
Auth: `ANTHROPIC_API_KEY` (or Bedrock / Vertex env vars). Gateway: `ANTHROPIC_BASE_URL`.

**Codex CLI**

```
codex exec --json \
  --sandbox workspace-write \
  --model <model> \
  -c model_reasoning_effort=<low|medium|high> \
  "<preamble + prompt>"
# continue: codex exec resume <sessionId> --json "<message>"
```
Auth: `OPENAI_API_KEY` (or `CODEX_API_KEY` where supported). Gateway: `OPENAI_BASE_URL` or a `model_providers` entry in a generated `config.toml` under a per-run `CODEX_HOME`. MCP servers: write them into that per-run `config.toml`.

**GitHub Copilot CLI**

```
copilot -p "<preamble + prompt>" \
  --output-format json \
  --allow-tool 'write' --allow-tool 'shell(git:*)' --allow-tool 'shell(pnpm:*)' \
  --deny-tool 'shell(git push)' \
  --model <model> \
  [--resume <sessionId>]
```
Auth: `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` from a user or service account with a Copilot seat. MCP servers: per-run config file (check where the CLI reads it; set a per-run config dir through env). Note: in some versions plain-text output does not reach stdout under `-p`; use JSON output and read `assistant.message` events.

Sandbox rule for all three: the container is the real security boundary. Inside it, give the harness the permissions it needs to work unattended, with `git push` and network egress controlled outside the harness (the worker pushes branches; the container network follows the runner allowlist).

### 8.3 The run preamble

The orchestrator writes `.zerovity/run/INSTRUCTIONS.md` for every run. Same text for every harness:

```
You are <agent name>, working phase <PHASE> of work item <ID>: "<title>".
Read .zerovity/context/CONTEXT.md before anything else.
Skills available to you are listed below with when to use each.
Write your result to .zerovity/out/result.json using the schema in .zerovity/run/result.schema.json.
If you need information from a person, put questions in result.json and stop. Do not guess.
Do not push, merge, or change git remotes. Commit your work on the current branch.
<agent body>
<skill index: name — description, one line each>
```

### 8.4 The result contract

Every run must end by writing `.zerovity/out/result.json`. This keeps the orchestrator independent of harness output styles.

```json
{
  "status": "done | needs_input | blocked | failed",
  "summary": "Two to five sentences a human can read in the UI",
  "questions": [
    { "id": "q1", "text": "Should refunds over $10k need a second approver?", "options": ["Yes", "No"], "why": "Spec section 3 depends on it", "kind": "decision | context_request" }
  ],
  "artifacts": [ { "path": ".zerovity/out/spec.md", "type": "spec" } ],
  "evidence": [ { "type": "test_run", "command": "pnpm test", "exitCode": 0, "logPath": ".zerovity/out/test.log" } ],
  "recommendation": "accept | revise | escalate",
  "findings": [ { "severity": "high", "file": "src/refund.ts", "line": 42, "text": "..." } ],
  "triage": { "complexity": "S|M|L", "risk": "low|medium|high", "skipSpec": false },
  "pathsTouched": ["src/refund.ts"]
}
```

If the file is missing or invalid, the worker runs one repair follow-up in the same session ("write result.json now, per the schema"). If that fails too, mark the run `failed` with reason `no_result`.

### 8.5 Usage and cost

Each adapter extracts token usage from its JSON events. Cost is computed from a price table in Postgres (`model_prices`, editable in Settings) when the harness does not report cost. For Copilot, record premium-request counts as well as tokens where available. Usage is stored per run and rolled up per work item, agent, harness, model and factory.

---

## 9. Context: letting users give the factory more to work with

This is a headline feature. Treat it with the same care as the orchestrator.

### 9.1 Context layers

| Layer | Who sets it | Examples |
|---|---|---|
| org | Platform admins | Coding standards, security policy, regulatory rules (GxP, 21 CFR Part 11, HIPAA), approved libraries |
| factory | Factory owners | Architecture overview, domain glossary, service boundaries, ADRs |
| repo | Repo owners | Conventions, how to run tests, known flaky areas (also read from the repo's own AGENTS.md / CLAUDE.md) |
| workItem | Requester and anyone on the item | Screenshots, logs, a spec from the client, links, answers to agent questions |
| phase | Attached to one phase of one item | "For the BUILD phase use the feature-flag pattern in docs/flags.md" |

### 9.2 Context item types

`note` (Markdown), `file` (PDF, DOCX, XLSX, images, text; converted to Markdown or described at upload and stored with the original), `url` (fetched and snapshotted at attach time, refresh on demand), `glossary` (term + definition), `adr` (title, status, decision), `repoPointer` (repo + path glob, read live from the worktree), `ticket` (Jira/GitHub issue snapshot).

Every item has: `id`, `layer`, `scopeId`, `title`, `kind`, `tags`, `appliesTo` (phases, agents), `priority` (`always | relevant | on_request`), `tokens` (counted at save), `createdBy`, `createdAt`, `version`.

### 9.3 Assembly

The context assembler (`packages/context`) builds `.zerovity/context/` in the worktree before every run:

- `CONTEXT.md` — an index plus all `always` items for this agent and phase, ordered org → factory → repo → workItem → phase, then the work item's question-and-answer history.
- `items/<id>.md` — `relevant` and `on_request` items, listed in the index with one-line summaries so the agent opens them only when needed.
- A token budget per agent (default 12k tokens for `CONTEXT.md`). When over budget, drop `relevant` items to the index-only form starting from the lowest priority and oldest; never drop work-item answers.

Store the exact assembled bundle hash on the run, so anyone can see what an agent was given.

### 9.4 Context requests from agents

When an agent returns a question with `kind: context_request` ("I need the refund policy document"), the inbox shows it as an upload/attach form instead of a text box. Whatever the user attaches becomes a workItem context item and the foreman resumes the same agent session.

### 9.5 UI for context

- **Context Library** page per factory and org: list, search, tag filter, editor, upload, URL snapshot, version history.
- **"What the agent sees"** preview on every work item and every agent: pick an agent and phase, see the assembled `CONTEXT.md` and the token count per item, toggle items on/off for this work item.
- **Drop anywhere**: dragging a file or pasting a link onto a work item page attaches it as context.

---

## 10. Orchestration

### 10.1 Work item state machine

States: `INTAKE → INTENT → SPEC → AWAITING_SPEC_APPROVAL → BUILD → VERIFY → AWAITING_HANDOFF → COMPLETE`, plus `NEEDS_INPUT`, `BLOCKED`, `FAILED`, `CANCELLED` reachable from any active state.

Transitions:

| From | Event | To |
|---|---|---|
| INTAKE | created | INTENT, or SPEC/BUILD if the foreman advisor decides the request is already well defined |
| INTENT | run done, `triage.skipSpec=false` | SPEC |
| INTENT | run done, `triage.skipSpec=true` | BUILD |
| any phase | run `needs_input` | NEEDS_INPUT (remembers the phase) |
| NEEDS_INPUT | all questions answered | back to the remembered phase, resuming the same agent session |
| SPEC | run done | AWAITING_SPEC_APPROVAL (if gate required) or BUILD |
| AWAITING_SPEC_APPROVAL | approved | BUILD |
| AWAITING_SPEC_APPROVAL | changes requested | SPEC (same session, with the reviewer's comments) |
| BUILD | run done | VERIFY |
| VERIFY | `recommendation=revise` | BUILD (same executor session, with findings), max 3 loops then AWAITING_HANDOFF with a flag |
| VERIFY | `accept` or `escalate` | AWAITING_HANDOFF |
| AWAITING_HANDOFF | person marks handed off, or PR merged/closed | COMPLETE |
| any | run failed twice in a row | BLOCKED |
| any | user cancels | CANCELLED |

Implement as a pure function `next(state, event, policy) → { state, actions[] }` with exhaustive tests. Actions are things like `dispatchRun`, `createInboxItem`, `postSourceComment`, `openDraftPr`.

### 10.2 The foreman

The foreman is the orchestrator plus a small LLM advisor. The advisor is called only at decision points:

- On intake: which phase to start in, and whether to ask the requester something first.
- After any `needs_input`: rewrite agent questions into one clear message to the requester.
- After VERIFY: summarise findings for the handoff message.

The advisor returns structured JSON (validated with Zod). Its decisions, inputs and the policy that applied are written to the audit log. If the advisor fails, fall back to the default path. The foreman is the only component that posts to the source (GitHub comment, web thread).

### 10.3 Same-session continuation

Each (work item, agent) pair keeps its harness `sessionId`. Revisions, answers and follow-ups resume that session instead of starting fresh, so the agent keeps its context. If the sandbox has been torn down, recreate it from the branch and resume with the harness's resume flag; if the harness cannot resume, start a new session with a summary of the previous one.

### 10.4 Git flow

- One branch per work item: `zerovity/<itemShortId>-<slug>`.
- One git worktree per run inside the sandbox, checked out from that branch.
- The spec-writer opens a draft PR containing `docs/specs/<itemShortId>.md`. The executor continues on the same branch and PR.
- The worker (not the agent) pushes after each run, with commit messages prefixed `[zerovity:<agent>]`.
- Agents never merge. Document that clients must enable branch protection; the GitHub App never requests merge permissions beyond what PR creation needs.

### 10.5 Concurrency and limits

- Per-factory concurrency limit (default 4 runs) and per-repo limit (default 2).
- Run timeouts kill the container and mark the run `timeout`.
- Budget checks before each dispatch: if the work item would exceed `maxCostPerWorkItemUsd`, move to NEEDS_INPUT with a budget question.

---

## 11. Integrations (v1)

### 11.1 GitHub App

- Webhooks: issues, issue comments, pull requests, PR reviews, check suites.
- Intake by label (`zerovity` or `zerovity:<alias>`) or by mention (`@zerovity <alias> ...`).
- The foreman replies in the issue thread with status and questions; answers in the thread route back to the waiting agent.
- Check run `zerovity/factory-config` on definition repos.
- Interface in `packages/forge/common` so GitLab and Azure DevOps can be added.

### 11.1a Jira

- Connect with Jira Cloud OAuth 2.0 (3LO) or, for Jira Data Center, a personal access token. Both are set up in the Connections screen (12.3).
- Intake: issue created or labelled (`zerovity`) in mapped projects, or a mention of the factory alias in a comment.
- The foreman posts status and questions as Jira comments; replies route back to the waiting agent. Optional status mapping (e.g. move to "In Review" at AWAITING_HANDOFF) set per project.
- Work items keep the Jira key as `source_ref`; the PR description links the issue, and the issue gets a remote link to the PR.
- Agents can read Jira through the connection (ticket snapshots as context items, section 9.2) without being given the token directly.

### 11.2 Web intake

A "New work item" composer in the UI: title, description, repo, attach context, choose starting phase (auto by default), choose notification route.

### 11.3 REST API

Versioned under `/api/v1`. Resources: factories, work-items, runs, inbox, agents, skills, packs, context, definitions, scorers, usage, audit. OpenAPI generated from the Zod schemas and served at `/api/v1/openapi.json`.

### 11.4 Factory MCP server

Streamable HTTP at `/mcp`. Auth by personal access token or OIDC device flow. Tools:

| Tool | Purpose |
|---|---|
| `list_factories` | Factories the caller can access |
| `send_task` | Create a work item, or hand work back to an existing one (with branch / PR reference and a note) |
| `list_tasks`, `search_tasks`, `get_task` | Find tasks; `get_task(start_working=true)` returns branch, worktree setup commands and the assembled context |
| `get_conversation`, `message_foreman` | Read and post to the work item thread |
| `add_context` | Attach a note, file or URL to a work item or the factory |
| `get_agent_context` | Return what a given agent would see for a task |
| `validate_definition`, `get_schema` | Help a local agent edit a factory definition |
| `complete_task` | Close out a task |

Provide copy-paste setup snippets in the UI for Claude Code (`claude mcp add --transport http zerovity <url>`), Codex (`config.toml` entry) and Copilot CLI (its MCP config).

---

## 12. Web UI

### 12.1 Design direction

The owner does not want a generic admin template or the usual rounded-box-and-arrow flow diagram. Aim for a control room that feels like watching a real production line, while staying dense and readable.

- Dark theme by default with a light theme; design tokens in `packages/ui-kit`.
- One accent per phase (INTENT, SPEC, BUILD, VERIFY, SHIP) used consistently in the floor, timelines, chips and charts.
- Typography: a sharp grotesk for UI text and a monospace for IDs, commands and logs.
- Motion with purpose: work items glide between phases, active runs pulse, a gate waiting on a person glows until handled. Respect `prefers-reduced-motion`.
- Dense information: every screen should answer "what is happening, what is stuck, what does it cost" without clicking.
- Keyboard first: `⌘K` command palette for everything (jump to item, approve, answer, attach context, switch factory).

### 12.2 Screens

1. **Floor** (factory home). A horizontal production line with five lanes, one per phase, plus a gate rail between SPEC and BUILD and a handoff dock at the end. Each work item is a token on the line showing ID, title, current agent avatar, elapsed time, cost so far and a ring for budget used. Tokens waiting on people sit on the gate rail. Hover shows the last event; click opens the item. Above the line: live counters (active runs, waiting on humans, completed today, spend today). Build this with SVG + Motion or visx; it must hold 200 items without lag (virtualise off-screen lanes).
2. **Inbox** (global, per user). Kinds: question, context request, spec approval, PR review, blocked, failed. Filters by factory, kind, read state; search. Side pane resolves the item in place: answer a question (options as buttons + free text), attach files for a context request, approve or request changes on a spec with inline comments on the rendered diff, open the PR. Items clear when no longer relevant; manual resolve with undo.
3. **Work item**. Header with phase track and state. Tabs: Conversation (foreman thread with the requester), Timeline (every run and gate, with agent, harness, model, duration, tokens, cost), Spec (rendered, with approval controls), Changes (diff viewer), Evidence (test logs, screenshots, findings), Context (layered list + "what the agent sees" preview + drop zone), Audit (hash-chained entries with verification badge).
4. **Run** (live). Streaming view of normalised events: assistant messages, tool calls collapsed by default, commands with exit codes, files changed, usage ticker. Controls: stop, send follow-up into the session while the sandbox is alive, download transcript. Uses SSE.
5. **Agents**. List with phase, harness, model, skills count and token weight. Agent editor: frontmatter as a form, body in Monaco, effective skill set with layer badges, "test run" against a sample work item, per-agent stats (success rate, average cost, average duration).
6. **Skills Library**. Org and factory skills, installed packs, versions, which agents use each skill. Skill editor with live lint, token count and a split preview. Pack import from Git URL or tarball; upgrade with diff.
7. **Context Library**. Section 9.5.
8. **Definition**. File tree + Monaco with JSON Schema completion, validate on save, commit with message. For Git-backed factories, read-only with a link to the repo and the last check result.
9. **Dashboard**. For a chosen range: work items completed, autonomy rate (merged PRs with no human code push), cycle time by phase (median per phase), cost per completed item, tokens by harness and model, gate wait time, revision loops per item, scorer pass rates. Charts in the same visual language as the floor.
10. **Scorers**. Create and edit rubrics, sampling rate, recent results, drill into failing runs.
11. **Connections**. Git, Jira, harness credentials, MCP servers, registries, webhooks and identity in one place; see 12.3.
12. **Settings**. Factory identity and alias, model price table, runners, concurrency and budgets, members and roles, notification routes, MCP setup snippets for local coding agents.

### 12.3 Connections

A dedicated screen for every outside system the factory talks to. Org admins manage connections at org level; factory owners choose which connections, repos and projects their factory uses. Nobody needs to edit YAML to connect a tool.

**Connection catalogue.** Cards grouped by type, each showing status (connected, needs attention, expired, not connected), who connected it, when, and the scopes granted.

| Type | v1 | Later |
|---|---|---|
| Code forge | GitHub (App install), GitHub Enterprise Server | GitLab, Azure DevOps, Bitbucket |
| Issue tracker | Jira Cloud, Jira Data Center | Linear, Azure Boards, ServiceNow |
| Chat | — | Slack, Microsoft Teams |
| AI harness credentials | Anthropic / Bedrock / Vertex keys for Claude Code, OpenAI key for Codex, GitHub token with a Copilot seat for Copilot CLI | |
| Model gateway | Zerovity gateway base URLs | |
| MCP servers | Any remote MCP server (URL + auth header) or stdio command | |
| Container registry | Private registry credentials for runner images | |
| Webhooks | Inbound authenticated webhooks (create, copy URL, rotate secret, delivery log) | |
| Identity | OIDC provider settings (org admins only) | SCIM user sync |

**Connect flows.**
- OAuth or app-install flows open in a popup and return to the screen with status updated (GitHub App install, Jira 3LO).
- Token-based connections use a form; the secret goes straight into the secrets store and is shown only as `••••last4` afterwards.
- Every connection has a **Test** button that runs a real call (list repos, fetch one Jira project, a tiny model request through each harness credential) and shows the result.

**Per-factory mapping.**
- Pick repositories from the connected GitHub org (searchable list with checkboxes) and set the default branch.
- Pick Jira projects, the intake label, and the optional status mapping.
- Assign harness credentials to agents (e.g. executor uses the team OpenAI key, verifier uses the Anthropic key).
- Choose which MCP servers each agent may use.
- Changes here write back into the factory definition (for UI-managed factories) or open a PR (for Git-backed factories), so the definition stays the source of truth.

**Health and audit.**
- Background checks every 15 minutes; expiring tokens and failing checks raise an inbox item for the connection owner and show a banner on affected factories.
- Every connect, disconnect, rotate and scope change writes an audit entry.
- Disconnecting shows which factories and automations depend on the connection before confirming.

### 12.4 Roles

`org_admin`, `factory_owner`, `approver`, `member`, `viewer`. Approvals require `approver` or the group named in `gates.yaml`.

---

## 13. Data model (Postgres)

Main tables (use ULIDs for IDs, `created_at`/`updated_at` everywhere):

- `orgs`, `users`, `memberships(user_id, org_id, factory_id?, role)`
- `factories(id, org_id, name, alias, definition_source, definition_commit, status)`
- `definition_versions(id, factory_id, commit, files_hash, applied_at, applied_by, valid)`
- `repositories(id, factory_id, forge, owner, name, default_branch, install_id)`
- `work_items(id, factory_id, short_id, title, body, source_type, source_ref, state, phase, paused_phase, branch, pr_url, requester_id, budget_usd, created_at)`
- `runs(id, work_item_id, agent_name, phase, harness, model, session_id, runner, status, started_at, ended_at, exit_reason, context_bundle_hash, result_json, tokens_in, tokens_out, tokens_cached, cost_usd)`
- `run_events(id, run_id, seq, kind, payload_json, ts)` — partition by month
- `questions(id, work_item_id, run_id, kind, text, options, answer, answered_by, answered_at)`
- `gates(id, work_item_id, type, status, decided_by, decided_at, reason)`
- `inbox_items(id, user_id, work_item_id, kind, status, read, resolved_at)`
- `skills(id, scope, scope_id, name, version, content_hash, token_count, source_pack)` and `packs(id, name, version, manifest, artifact_key)`
- `context_items(id, layer, scope_id, kind, title, tags, applies_to, priority, token_count, artifact_key, version, created_by)`
- `secrets(id, scope, scope_id, name, ciphertext, created_by)` — never returned by the API
- `connections(id, org_id, type, provider, display_name, auth_kind, secret_id, scopes, status, last_checked_at, last_error, created_by)`
- `factory_connections(factory_id, connection_id, mapping_json)` — repos, Jira projects, labels, status maps, agent assignments
- `model_prices(model, input_per_mtok, output_per_mtok, cached_per_mtok, effective_from)`
- `scorers`, `scores(run_id, scorer_id, label, score, rationale)`
- `audit_log(id, seq, factory_id, actor, action, subject, payload_hash, prev_hash, hash, ts)` — append-only; DB role for the app has INSERT and SELECT only

---

## 14. Security, audit and compliance

- **Isolation.** One container per run, non-root user, read-only root filesystem except the workspace and temp, egress allowlist per runner, CPU/memory limits, no Docker socket inside the sandbox.
- **Credentials.** Harness credentials and forge tokens are injected as env vars at container start and are not written to disk in the worktree. Short-lived GitHub App installation tokens only.
- **Least access.** Each agent receives only the secrets and MCP servers declared for it. What an agent can reach comes from configuration; instructions never widen access.
- **Audit log.** Every state transition, advisor decision, run start/end, gate decision, definition change, context change and secret access writes an audit entry. Each entry stores `hash = sha256(prev_hash + canonical_json(entry))`. `zf audit verify <factory>` and a UI badge check the chain. Export to JSONL and CSV.
- **Approvals.** Gate decisions record user, time, reason (required when policy says so) and the hash of what was approved (spec file hash, diff hash). This supports 21 CFR Part 11-style review trails; full e-signature (re-authentication at signing) is a config flag `gates.*.reauthenticate: true` implemented through the OIDC provider.
- **PII.** Redact obvious secrets and tokens from run events before storage (regex + entropy check). Configurable retention for run events and transcripts.

---

## 15. Milestones

Each milestone ends with its acceptance checks passing in CI.

**M0 — Skeleton**
Monorepo, lint, typecheck, Vitest, docker compose (Postgres, MinIO, api, worker, web), health endpoints, dev login, empty web shell with theme tokens.
*Accept:* `pnpm dev` brings everything up; `pnpm test` green; web shows a logged-in shell.

**M1 — Definition and validator**
`packages/definition` with JSON Schemas, loader, cross-reference checks, policy expression parser; `zf validate`; examples 01 and 02 validate.
*Accept:* invalid fixtures report the right file and line; schemas served over HTTP.

**M2 — Skills and packs**
Skill parser, linter with the limits in 7.2, resolver with layer precedence, pack format, lockfile, `zf skills lint`, `zf pack install` with ink UI, `zerovity-core` pack written in full.
*Accept:* lint catches every rule with fixtures; resolver tests cover overrides; core pack passes lint.

**M3 — Harness adapters and one run**
Runner base image with git, node, python and the three CLIs. Worker that creates a container, clones the repo, creates the worktree, materialises skills, writes the preamble and context, runs the adapter, streams normalised events into `run_events`, reads `result.json`, extracts usage, pushes the branch. Adapters for claude-code, codex, copilot with recorded fixtures of real JSON output for parser tests.
*Accept:* `zf run --agent zerovity-researcher --harness <each> --repo <test repo> --prompt "..."` completes for all three harnesses and produces a valid `result.json`; parser tests pass on recorded fixtures.

**M4 — Orchestrator**
State machine, policy engine reading `gates.yaml`, foreman advisor, dispatcher on pg-boss, session continuation, question handling, revision loops, budgets, concurrency limits, audit log writes.
*Accept:* exhaustive transition tests; an end-to-end test runs a work item from INTAKE to AWAITING_HANDOFF against a fixture repo using a fake harness adapter; audit chain verifies.

**M5 — Context system**
Context items CRUD, file conversion, URL snapshots, assembler with budgets and index, bundle hash on runs, context requests.
*Accept:* assembler tests for ordering, budget trimming and phase filters; a context request answered with a file resumes the agent with that file in its context.

**M6 — Web UI core**
Floor, Work item (all tabs), Run live view over SSE, Inbox with all kinds, command palette.
*Accept:* Playwright: create item from the composer, watch it move on the floor, answer a question in the inbox, approve the spec, see the PR link at handoff. Floor stays smooth with 200 seeded items.

**M7 — Connections, GitHub App and Jira**
Connections screen (12.3) with catalogue, connect flows, test buttons, per-factory mapping and health checks. GitHub App: webhook intake, label and mention triggers, thread replies and answers, draft PRs, factory-config check run. Jira Cloud and Data Center: intake, comments, status mapping, remote links.
*Accept:* from the UI alone (no YAML), connect a sandbox GitHub org and a Jira project and map them to a factory; labelling a GitHub issue or a Jira ticket produces a draft spec PR; an approval in the UI leads to code on the same PR; the source thread shows foreman updates; revoking the Jira token raises an inbox item within one health-check cycle.

**M8 — Studio screens**
Agents editor, Skills Library, Context Library, Definition editor, Settings (credentials, prices, runners, budgets, members).
*Accept:* change an agent's harness in the UI, see the next run use it; edit a skill, see lint and token count update live; definition edits validate and commit.

**M9 — Factory MCP server**
All tools in 11.4, PAT auth, setup snippets in Settings.
*Accept:* from Claude Code, Codex and Copilot CLI on a laptop, connect, `send_task`, `get_task(start_working=true)`, `message_foreman` and `add_context` all work against a running factory.

**M10 — Measure**
Dashboard metrics, scorers with sampling, usage rollups, cost per item, exports.
*Accept:* seeded data renders every chart; a scorer classifies sampled runs and results show on the Dashboard.

**Later:** Linear intake, Slack and Teams, GitLab and Azure DevOps, Kubernetes runner backend, benchmarks, self-improvement PRs against the definition, Helm chart, OPERATE-phase automations.

---

## 16. Quality bar

- TypeScript strict mode, no `any` in public interfaces.
- Every API route validated by Zod on input and output.
- Every state transition and every audit write covered by tests.
- Harness parsers tested against recorded real output (store fixtures under `packages/harness/<tool>/fixtures/`, with secrets stripped).
- Web: Lighthouse accessibility ≥ 95 on Floor, Inbox, Work item. Full keyboard support.
- Logs are structured JSON with `factoryId`, `workItemId`, `runId` on every line.
- `docs/ARCHITECTURE.md` kept current with a diagram of the services and the run lifecycle.

---

## 17. Open questions for the owner

Record answers in `DECISIONS.md` when they arrive. Until then, use the default in brackets.

1. Does a factory need to serve several client tenants on one deployment, with hard data separation? [No; one org per deployment in v1, multi-org schema kept ready.]
2. Should the Zerovity gateway (token economics layer) ship inside this repo or stay a separate service the factory points at? [Separate; the factory only needs base URLs and reads usage from harness output.]
3. Copilot CLI licensing for unattended use: service account with a Copilot seat, or each requester's own token (`credentialStrategy: creator`)? [Service account, with creator mode as an option.]
4. Which IdP for the first client pilots? [Entra ID.]
5. Do approvals need full re-authentication e-signatures in the first pilot? [Off by default, flag available.]

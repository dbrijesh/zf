# Zerovity Factory

A self-hostable software factory. A factory is a team of agents attached to your repositories. Work arrives from a GitHub issue, a Jira ticket, the web composer, the REST API, a webhook, a schedule or a local coding agent (MCP). A foreman moves each work item through **INTENT, SPEC, BUILD, VERIFY, SHIP**, stops for people at defined gates, and ends by handing a pull request with evidence to a person. **Agents never merge.**

Three things drive the design: agents and skills stay small and reusable, people can give the factory context easily at any level, and a strong web UI runs the whole thing. Version 1 runs **Claude Code**, **OpenAI Codex CLI**, **GitHub Copilot CLI** and **Cursor CLI**.

## Try it in two minutes (no database, no Docker, no model)

```
npm install
npm run build          # builds the web app
ZF_SEED=demo ZF_FORCE_HARNESS=fake ZF_DEV_LOGIN=1 npm start
```

Dev login lets anyone sign in as any user, so it only starts on a local address (`localhost`). To use a tunnel for webhooks, configure OIDC, or set `ZF_ALLOW_PUBLIC_DEV_LOGIN=1` for a short, supervised trial.

Open http://localhost:8787 and pick a demo user (the approver is `priya@acme.test`). The factory is seeded with two weeks of history and live items driven by the offline `fake` harness, so you can answer a question, attach a file, approve a spec and watch a work item reach handoff. For hot reload use `npm run dev` (web on http://localhost:5173).

## Use real harnesses

Install the CLIs you want (`claude`, `codex`, `copilot`, `agent` for Cursor), then:

```
node apps/cli/bin/zf.mjs doctor
node apps/cli/bin/zf.mjs run --agent zerovity-researcher --harness claude-code --repo ./my-repo --prompt "Investigate ..."
```

`zf run` materialises the skills, writes the run preamble and context, runs the harness and checks the result contract, with no server. In the app, add credentials under **Connections** (they are stored encrypted and shown only as `••••last4`) and set each agent's harness in **Agents**.

## Deploy

```
cp .env.example .env            # set ZF_MASTER_KEY, OIDC_*, passwords
docker build -t zerovity-runner-base:latest docker/runner-base
docker compose up --build       # postgres, minio, api (+ web), worker
```

Production uses OIDC (Entra ID, Okta, Keycloak) and `ZF_DEV_LOGIN=0`. Put the API behind TLS, enable branch protection on every repository, and restrict the GitHub App to the repositories the factory should touch.

## What is in the box

| | |
|---|---|
| `packs/zerovity-core` | The default team: researcher, spec-writer, executor, verifier, shipper and 14 light skills (each under 150 lines; an agent adds roughly 150-300 tokens that are always loaded, the rest loads on demand) |
| `apps/web` | Floor, Inbox, Work item (conversation, timeline, spec review with inline comments, changes, evidence, context, audit), live Run view, Agents, Skills library, Context library, Definition editor, Dashboard, Scorers, Connections, Settings, command palette |
| `apps/cli` | `zf validate`, `zf skills lint`, `zf pack install` (animated picker), `zf pack lock`, `zf run`, `zf send`, `zf tasks`, `zf audit verify`, `zf schema` |
| `apps/mcp` | The factory MCP server: `send_task`, `get_task(start_working)`, `message_foreman`, `add_context`, `get_agent_context`, `validate_definition`, `get_schema`, `complete_task`, ... Snippets for Claude Code, Codex and Copilot are in Settings |
| `examples/` | `01-single-repo` and `02-issue-to-pr` factory definitions |
| `docs/` | `USER_GUIDE.md` (start here), `CAPABILITIES.md` (everything it can do), `CODE_REVIEW.md` (security and correctness findings, all fixed), `ARCHITECTURE.md`, `architecture.mmd` and `work-item-lifecycle.mmd` (Mermaid diagrams; GitHub renders them), `DECISIONS.md` |

## Commands

`npm test` (unit and integration, 460+ tests), `npm run e2e` (Playwright), `npm run typecheck`, `npm run lint`, `npm run schemas` (JSON Schemas for every definition file; also served at `/api/v1/schemas/zf/v1alpha1/<doc>.json`), `npm run seed`.

## Honest status

Verified in this repository: the state machine (exhaustive matrix), the full pipeline with the fake harness (questions, context requests, revision loops, risk gates, failures, repair, budgets, cancel), a real Claude Code run through `zf run`, the API (38 integration tests, OpenAPI generated from Zod), the MCP server, webhook signatures and intake, the UI end to end in a real browser (8 Playwright tests including a 200-item floor), and the audit chain.

Written to the spec but **not exercised here** because the build machine had no Docker, no git, no Codex or Copilot CLI and no GitHub, Jira or IdP accounts: the Docker sandbox and egress proxy, the git clone/commit/push path (tests skip when git is missing), the GitHub App and Jira clients against live services (tested against mocked HTTP), OIDC login, S3/MinIO storage, the standalone worker with real Postgres, and the Codex and Copilot parsers (synthetic fixtures; see `docs/DECISIONS.md` D-016). Treat those as the first things to run in your pilot environment.
# Zerovity Factory: user guide

This guide explains how to use the factory from start to finish. No coding knowledge is needed for everyday use.

## 1. The idea in one minute

You attach the factory to a code repository. When you add the label `zerovity` to a GitHub issue, a small team of AI agents takes the work:

1. **Intent**: the researcher reads the issue and the repository and decides what is being asked.
2. **Spec**: the spec-writer writes what will be built. **You approve it.**
3. **Build**: the executor writes the code on its own branch.
4. **Verify**: the verifier checks it and collects evidence.
5. **Ship**: the shipper prepares the pull request.
6. **Handoff**: you review the pull request and merge it yourself.

Agents never merge. You are always the last step.

## 2. Try it first (demo mode)

Demo mode needs no accounts and no AI model. It runs pretend agents so you can see how everything works.

```
npm install
npm run build
ZF_SEED=demo ZF_FORCE_HARNESS=fake ZF_DEV_LOGIN=1 npm start
```

On Windows PowerShell, set the three values first (`$env:ZF_SEED='demo'` and so on), then run `npm start`.

Open http://localhost:8787 and sign in as a demo user. `priya@acme.test` is an approver.

## 3. Set up for real

You need: Node 22 or newer, git, and the Claude Code CLI signed in (`claude`).

### 3.1 Start the factory
Set these values, then run `npm start`:

| Setting | What it is |
|---|---|
| `ZF_MASTER_KEY` | A random secret that encrypts stored credentials. Keep it, and use the same one every time. |
| `ZF_PUBLIC_URL` | The public web address of your factory (needed for GitHub webhooks). |
| `ZF_DEV_LOGIN=1` | Lets you sign in with any email. For trials only. |

Make a master key in PowerShell:
```
[Convert]::ToBase64String((1..32 | % { Get-Random -Max 256 }) -as [byte[]])
```

### 3.2 Make your computer reachable by GitHub
GitHub must be able to send events to the factory. If you have no fixed address, use a tunnel:
```
cloudflared tunnel --url http://localhost:8787
```
It prints an address like `https://something.trycloudflare.com`. Quick tunnel addresses change when restarted. For a permanent address, use a named Cloudflare tunnel with your own domain, or an ngrok static domain.

### 3.3 Create a GitHub App
In GitHub: Settings, Developer settings, GitHub Apps, New GitHub App.

- **Webhook URL:** `<your public address>/api/v1/webhooks/github`
- **Webhook secret:** make up a long random string and keep it.
- **Repository permissions:** Contents, Pull requests, Issues and Checks (read and write); Metadata (read).
- **Events:** Issues, Issue comment, Pull request, Pull request review, Pull request review comment, Check suite, Push.

Then: generate a private key (a `.pem` file), and **install the app** on your repository.

### 3.4 Add the connection in the factory
Go to **Connections**, add **GitHub App**, and fill in the App ID, the private key (paste the whole `.pem` text), the webhook secret (the same string as in GitHub) and click **Test**. You should see "repository visible".

### 3.5 Point the factory at your repository
Go to **Definition**, open `zerovity.factory.yaml` and set your repository. Use a minimal file like this:

```yaml
schemaVersion: zf/v1alpha1
name: my-factory
alias: myrepo
shortIdPrefix: ZF
repositories:
  - forge: github
    owner: your-github-name
    name: your-repo
    defaultBranch: main
packs:
  - name: zerovity-core
    version: ^1.0.0
agentDefaults:
  harness:
    type: claude-code
    model: claude-sonnet-5-5
  idleTimeoutMinutes: 30
  maxRunMinutes: 60
  budget:
    maxCostPerWorkItemUsd: 5
agentOverrides:
  zerovity-executor: { harness: { type: claude-code } }
  zerovity-verifier: { harness: { type: claude-code } }
integrations:
  github:
    triggerLabel: zerovity
```
Click **Save**. If something is wrong the editor shows the file and line. A bad save is never applied.

Tip: the example factory includes a sample `label-intake` automation for a made-up repository. Delete it, or the plain `zerovity` label will not trigger.

## 4. Your first work item

1. In your repository, create the label `zerovity`.
2. Open an issue describing a small change and add the label.
3. In the factory, the item appears on the **Floor**.
4. Open the **Inbox**. Answer any questions from the agents.
5. When the spec is ready, review it. Click **Approve**, or add comments and choose **Request changes**.
6. Watch the build, verify and ship steps on the **Run** page.
7. At handoff, open the pull request on GitHub, review it, and merge it if you are happy.

You can also create an item from the **+ New** button in the factory, without GitHub.

## 5. The pages

| Page | What you do there |
|---|---|
| **Floor** | See every item on the line, by phase. Click one to open it. |
| **Inbox** | Answer questions and approve gates. Use the keyboard; undo after resolving. |
| **Work items** | Search all items. Open one to see its conversation, timeline, spec, changes, evidence, context and audit trail. |
| **Runs** | See each agent run. Open one to watch it live, stop it, send a message, or download the transcript. |
| **Agents** | See each agent, its harness and model, its skills and how much text it always loads. Try an agent on a sample request. |
| **Skills library** | Browse, edit and create skills. Pack skills are read-only; fork one to change it. |
| **Context library** | Add notes, glossaries, decisions, links and files that agents should know. |
| **Definition** | Edit the factory files, see the history, compare versions and roll back. |
| **Connections** | Add and test GitHub, Jira, model keys and webhooks. |
| **Dashboard** | Cost, throughput, how often work finished without human code changes, quality scores. |
| **Scorers** | Define automatic quality checks. |
| **Settings** | Factory details, runners, gates policy, model prices, members and roles, secrets, access tokens, and snippets for connecting your own coding agent (MCP). |

Press **Ctrl+K** (Cmd+K on Mac) anywhere to jump to an item, agent, skill or action.

## 6. Watching a live run

The run page shows messages, commands, file changes, tokens and cost as they happen. While a long command is running, a bar above the events shows what it is and for how long, for example `running: npm ci  6m 12s`. Output from that command appears when it finishes.

The agent has a time limit, an idle limit (no activity) and a cost limit. If a run is stopped, the item becomes **Blocked**. Click **Retry** to continue.

## 7. Giving the factory context

Agents work better with your knowledge. In the **Context library** you can add:

- short notes and a glossary of your terms
- decision records
- links (the page is fetched and saved)
- files (converted to text)

Context can apply to the whole factory, one repository, one agent, or one work item. You can also attach a file when you answer a question in the Inbox. Every run records exactly which context it received.

## 8. Roles

| Role | Can do |
|---|---|
| Viewer | Look. |
| Member | Create items, answer questions, stop runs. |
| Approver | Approve and reject gates. |
| Factory owner | Edit the definition, skills and connections. |
| Org admin | Everything, including users. |

## 9. The command line

Run commands with `node apps/cli/bin/zf.mjs <command>`:

| Command | Does |
|---|---|
| `validate <folder>` | Checks a factory definition. |
| `skills lint <folder>` | Checks skills for size and quality. |
| `pack list`, `pack install` | Browse and add skill packs (animated picker). |
| `run --agent <name> --repo <folder>` | Runs one agent locally, without a server. |
| `login`, `send "title"`, `tasks` | Talk to a running factory. |
| `audit verify` | Confirms nobody tampered with the audit log. |
| `doctor` | Shows which agent CLIs are installed. |

## 10. Using the factory from your own coding agent

The factory has an MCP server at `<address>/mcp`. In **Settings** you will find ready-made snippets for Claude Code, Codex and Copilot. Create an access token first. Your own agent can then send tasks, read them, add context and report results.

## 11. Troubleshooting

| Problem | What to do |
|---|---|
| GitHub shows a 401 for the webhook | The webhook secret differs between GitHub and the factory. Set the same one in both. |
| Webhook arrives but nothing is created | Check the label is exactly `zerovity`, the repository is in the definition, and no leftover automation is blocking the plain label rule. See **Connections, Webhooks** for the reason. |
| "The GitHub App is not installed" | Install the app on your repository. |
| Run fails with an unknown model | The agent has a model from another harness. Set the model in the definition. |
| Run stops after being quiet | Raise `idleTimeoutMinutes`, then Retry. |
| Push fails | Make sure git is installed and on the PATH of the process that runs the factory. |
| The factory refuses to start: "dev login is enabled but ZF_PUBLIC_URL is not a local address" | Dev login lets anyone sign in as anyone, so it is blocked on public addresses. Configure OIDC and set ZF_DEV_LOGIN=0, or for a short supervised trial set ZF_ALLOW_PUBLIC_DEV_LOGIN=1. |
| Public address stopped working | Quick tunnel addresses change on restart. Update `ZF_PUBLIC_URL` and the GitHub App webhook URL, or use a permanent tunnel. |
| Page looks stale after an update | Hard refresh (Ctrl+Shift+R). |

## 12. Good habits

- Start with small, clear issues.
- Keep issue text specific: what should change, and how will you know it works.
- Keep your master key and GitHub private key private. Never paste them into chats or commit them.
- Turn off `ZF_DEV_LOGIN` and use OIDC before exposing the factory to other people.
- Keep branch protection on in GitHub so a person always merges.

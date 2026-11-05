<p align="center">
  <img src="docs/assets/orbit-mark.svg" width="88" height="88" alt="Orbit logo" />
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  <strong>All your projects. One place. An AI team that works the way you do.</strong><br />
  Open any project in a tab and let Claude or Codex change it, like having five Claude Code terminals open,<br />
  with a team of agents for planning, reviewing, security and better tasks when you want them.
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0b7c71" />
  <img alt="Node.js 22.11+" src="https://img.shields.io/badge/node-22.11%2B-1c2333" />
  <img alt="Local first" src="https://img.shields.io/badge/runs-on%20your%20machine-f3ae3d" />
  <img alt="Status: early" src="https://img.shields.io/badge/status-0.1%20early-5d6677" />
</p>

---

## What Orbit is

Orbit is a local app for solo and indie developers who work on several projects at once. You open one dashboard and:

- **work in any project** with an AI agent that reads and edits it directly, in tabs, side by side;
- **see every step** the agent takes, in plain words, and approve commands with one click;
- **review and commit** the changes without leaving the app;
- **hand whole tasks to Autopilot**, where a small team of agents plans, builds, reviews and checks security before you approve anything;
- **use the AI you already pay for**: your Claude Code plan and your Codex (ChatGPT) login, with automatic switching when one hits its usage limit.

Everything runs on your machine with your own logins. There is no hosted service and no Orbit account.

## The workspace

The workspace is the home screen. Your projects are on the left; click one and a tab opens.

| In a tab you can | |
|---|---|
| **Tell the agent what to change** | It edits the real files, like Claude Code in a terminal, and remembers the conversation. |
| **Watch it work** | Each step is one line: *Read cart.ts*, *Edited README.md*, *Running npm test*. |
| **Choose how commands run** | **Ask first** (you click *Allow*) or **Auto-accept** (like Claude Code's auto mode: commands run on their own, a safety check still blocks risky ones). |
| **Pick the AI** | Auto, Claude or Codex, per tab. |
| **Review and commit** | The Changes panel shows every changed file and the diff, with a Commit button. |
| **Check security** | One click asks the Security reviewer to look over your uncommitted changes. |
| **Improve your request** | The Prompt engineer turns a rough message into a clear one before you send it. |

Each tab has a status light, so with several projects open you see at a glance which one needs you: teal is working, amber needs your OK, green is finished, red stopped with a problem.

## Your agents

Each agent has one job and the AI that suits it. You can change the AI, model and effort for each one on the **Agents** page; **Settings** shows them all at a glance.

| Agent | Job | Used |
|---|---|---|
| **Session agent** | Works with you directly in a project | Every message in a workspace tab |
| **Prompt engineer** | Rewrites rough tasks into clear ones with acceptance criteria | When you click *Improve* (workspace or Asana task) |
| **Security reviewer** | Looks for leaked secrets, injection, missing auth checks, risky dependencies | *Check security*, and every Autopilot task |
| **Planner** | Reads the task and your code, picks the right project, writes the plan | Autopilot |
| **Engineer** | Builds the plan in a separate copy of the project and adds tests | Autopilot |
| **Reviewer** | Checks the real diff against the plan and the test results | Autopilot |

On **Auto**, the reviewers use a different AI from the one that wrote the code, so every change gets a second opinion. If an AI is not ready or hits its usage limit, Orbit hands the step to the other one and says so.

## Autopilot

For tasks you want done hands-off (for example from Asana), Autopilot runs the whole team:

```
Plan ──► Build ──► Your checks ──► Review ──► Security ──► You approve ──► Pull request
```

It works in a separate copy of the project on its own branch, sends failing checks and serious findings back to the engineer automatically, and never commits, pushes or opens a pull request without your approval. Orbit never merges.

## Quick start

You need **Node.js 22.11+**, **git**, and at least one AI:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), signed in (run `claude` once), or an `ANTHROPIC_API_KEY`;
- optionally [Codex](https://github.com/openai/codex) (`npm install -g @openai/codex`, then `codex login`).

```bash
git clone https://github.com/<you>/orbit.git
cd orbit
corepack enable        # provides pnpm
pnpm install
pnpm build
pnpm orbit start       # opens the dashboard at http://127.0.0.1:7420
```

The first visit walks you through setup. Add a project (any folder on your computer), open it in the workspace, and start talking.

Want to try it on something disposable first?

```bash
pnpm demo:repo ~/orbit-demo      # a tiny project with tests
```

## Save tokens, orchestrate smart

- **Everyday changes: use a workspace tab.** That is one agent, about the same cost as Claude Code in a terminal.
- **One topic per session.** Start a new session for a new topic; long sessions carry more context.
- **Match the model to the job** on the Agents page: a fast model for routine work, the strongest one for hard problems.
- **Auto-accept** saves the extra round trip each *Allow* click costs.
- **Spread the load:** give the Reviewer or Prompt engineer to Codex so both subscriptions share the work.
- **Autopilot is the full team** (at least four agent runs per task). Lower *Automatic fix passes* in Settings, or turn off the security review for projects that do not need it.

## Safety

Orbit lets AI change code, so the guardrails are built in:

- **You hold the gates.** Nothing is committed, pushed or published without your click. Orbit never merges.
- **Hard limits in every mode.** Agents can never push, commit, change git settings, use `gh`, `sudo` or `ssh`, or read `.env` and key files.
- **Commands need your OK** in *Ask first*; in *Auto-accept* a safety check blocks risky ones. Codex always runs inside its own sandbox (no network, no git writes).
- **Your projects stay yours.** Settings files inside a project cannot loosen Orbit's rules. Autopilot works in a separate copy of the project.
- **Your credentials stay where they are.** Orbit uses Claude Code's and Codex's own logins and never reads them. Integration tokens live in `~/.orbit`, outside your projects, and output is scanned and redacted for secrets.
- **Local only.** The API listens on 127.0.0.1 and requires a random token.

More in [SECURITY.md](SECURITY.md).

## Connect Asana (optional)

Connect a personal access token in **Integrations**, map Asana projects to your repositories, then:

- click **Improve** on a task to have the Prompt engineer rewrite it, and **Update in Asana** when you like it;
- click **Run on Autopilot**, or comment `/orbit run` on the task.

Details in [docs/asana.md](docs/asana.md).

## More

| | |
|---|---|
| [docs/installation.md](docs/installation.md) | Installing and running Orbit |
| [docs/claude-code.md](docs/claude-code.md) | Using Orbit from Claude Code (MCP server) |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common problems |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the engine, agents and dashboard fit together |
| [CHANGELOG.md](CHANGELOG.md) | What changed |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Developing Orbit |

## Development

```bash
pnpm dev          # API (tsx watch) + dashboard (Vite)
pnpm test         # unit and integration tests (real git)
pnpm test:e2e     # dashboard flow with Playwright
pnpm typecheck
pnpm build        # dashboard + the bundled `orbit` command
```

```
apps/web            Dashboard (React, Vite, Tailwind)
apps/server         Local API, auth, live updates
packages/core       Sessions, Autopilot engine, orchestrator, workspace
packages/agents     Claude Code, Claude Agent SDK and Codex runtimes, prompts, tool policy
packages/git        git and gh wrappers
packages/database   SQLite schema and migrations
packages/integrations-asana   Asana connector
packages/cli        The `orbit` command
packages/mcp        MCP server for Claude Code
```

## License

[MIT](LICENSE)

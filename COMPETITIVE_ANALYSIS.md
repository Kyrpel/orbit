# Competitive analysis

Researched November 2026. Facts about other products come from their public repositories, documentation and announcements at that time; check the linked sources before relying on details, because this space moves monthly.

## Summary

| | Orbit | Paperclip | GitHub Copilot cloud agent | Asana AI Teammates | Claude Code alone |
|---|---|---|---|---|---|
| Focus | Task → reviewed PR across *your* repos | Running an "AI company": org charts, goals, budgets | Issue → draft PR in GitHub | General work agents inside Asana | Interactive coding agent |
| Runs where | Your machine | Self-hosted server | GitHub Actions runners | Asana cloud | Your machine |
| Asana | `/orbit run` on any plan, progress comments, project mapping | Roadmap ("bring your own ticket system") | Not among announced integrations (Linear, Jira) | Native | — |
| Repo routing | Planner proposes repos with evidence; you confirm | Project workspaces | Repository chosen per assignment | — | The repo you opened |
| Human gates | Scope (when ambiguous), change review, publish | Configurable approvals | Review the draft PR | Configurable | Per-tool permissions |
| Price of entry | Free (MIT) + your model usage | Free (MIT) + model usage | Paid Copilot plan | Enterprise tiers (reported) | Claude plan or API |

## Paperclip (github.com/paperclipai/paperclip)

What it is: an MIT-licensed Node.js server and React UI for orchestrating teams of agents "to run a business". Concepts include companies, org charts with reporting lines, goals, tickets with atomic checkout and execution locks, heartbeats with a DB-backed wakeup queue, budgets with hard stops, governance and approval stages, adapters for many agent CLIs (Claude Code, Codex, Cursor, Gemini, OpenCode and more), plugins, routines, secrets management, and optional git-worktree workspaces. It requires Node.js 24.11+, embeds PostgreSQL for local use and ships a native runner. Its roadmap lists "Bring-your-own-ticket-system (Asana / Linear / Jira as on-ramps)" as planned, not shipped.

What Orbit adopts as concepts (independently implemented, no code or UI copied):

- **Specialized roles**: Orbit keeps three (planner, engineer, reviewer), started on demand.
- **Durable execution history**: every mission event is stored and streamed.
- **Execution locks and a DB-backed queue**: SQLite jobs with leases and partial unique indexes.
- **Approval workflows**: three explicit gates with recorded decisions.
- **Worktree isolation**: every mission gets its own worktree and branch.
- **Usage monitoring and budgets**: per-run budget caps, cost per run and per mission.
- **Runtime adapters**: an `AgentRuntime` interface with SDK, CLI and scripted implementations.
- **Bounded recovery**: restart recovery with limited retries.

Where Orbit differs:

- **Scope**: Orbit does one job, task to reviewed PR, and hides orchestration. Paperclip models an organization.
- **Footprint**: SQLite and a single process on Node 22.11+; no embedded Postgres or native runner.
- **Ticket systems first**: Asana works today (free plan, comment trigger, progress comments), with a provider-neutral core for Linear, Jira and GitHub Issues.
- **Routing with evidence** across several repositories, and no repository is ever added without your approval.

## GitHub Copilot cloud agent

GitHub's agent works on issues assigned to Copilot and produces a draft pull request, running in an ephemeral GitHub Actions environment. In 2026 GitHub announced generally available integrations for Jira (late June; requires a paid Copilot plan, Jira Cloud and Atlassian Rovo) and Linear (late July; requires admin setup on both sides). Sources: GitHub Copilot integrations documentation and 2026 changelog coverage.

Orbit's angle: local execution on your machine (your toolchain, your private dependencies), Asana support, explicit routing across several repositories, review before any commit, and no paid seat.

## Asana AI Teammates

Asana launched AI Teammates (configurable agents inside Asana) in 2026 and positioned the platform as an operating system for human and agent work. Reports say the feature is part of enterprise tiers. We did not find an official first-party flow that turns Asana tasks into code changes and pull requests in your repositories.

Orbit's angle: it brings real repositories, tests and pull requests to Asana tasks on any plan, while leaving project management in Asana.

## Other tools

- **Claude Code GitHub Actions** (`@claude` mentions on issues and PRs) and **Claude Code** itself: excellent engines; Orbit uses Claude Code (CLI or Agent SDK) as its runtime and adds tracker integration, routing, gates, durable state and auditing around it.
- **Local agent managers** (worktree-based orchestrators for running several coding agents in parallel): strong for interactive parallel work inside one repo; Orbit is tracker-driven and approval-centric.
- **Hosted autonomous engineers** (cloud sandboxes taking tickets from Slack, Linear or Jira): powerful but hosted, paid, and outside your machine.

## Gaps and risks for Orbit

- Native Asana UI entry point needs a public app server, OAuth and Asana's Security + QA review for distribution (Milestone 6).
- Asana's Events API is at-most-once and does not bump `modified_at` for comments, so missed triggers after long downtime are possible; Orbit reconciles recent tasks and documents the limit.
- OS sandboxing depends on Claude Code's sandbox; it is not available on native Windows today, where Orbit requires informed trusted-local consent.
- Multi-repository missions are supported in the data model and pipeline but have had less real-world use than single-repository missions.

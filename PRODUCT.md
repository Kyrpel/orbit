# Orbit product brief

## Promise

**Turn a task into a reviewed pull request.**

Orbit is the AI development team for solo developers. It connects the place where you write down work (Orbit itself, your terminal, Asana today; GitHub Issues, Linear and Jira next) to the repositories where the work happens, and delivers reviewable, tested changes. You stay the decision maker at every gate that matters.

## Who it is for

Solo developers and very small teams who:

- maintain several repositories (an app, an API, a shared package, side projects);
- already plan work in a tracker or a notes file;
- want AI to do the implementation legwork, but will not let it push code unseen.

They should understand Orbit in minutes, without configuring an "AI organization".

## Jobs to be done

1. *"I wrote a task. Do it in the right repository and show me the change."*
2. *"Tell me which of my tasks are ready, and run the ones I pick."*
3. *"Keep me in control: no surprise pushes, no surprise costs, no surprise repositories."*
4. *"Tell my tracker what happened, with the PR link."*

## Principles

1. **Run with Orbit is one action everywhere.** Dashboard, `/orbit run` comment, CLI and Claude Code all create the same mission in the same engine.
2. **Humans hold the gates.** Scope (when ambiguous), change review and publishing. Orbit never merges.
3. **Evidence over claims.** The diff comes from git, check results from commands Orbit runs, cost from the runtime. Agent prose is never treated as proof.
4. **Small team, on demand.** Three roles (planner, engineer, reviewer) started per mission. No always-on agents.
5. **Local first.** Your machine, your repositories, your credentials. No hosted account.
6. **Provider neutral core.** Asana is the first connector, not a dependency of the engine.
7. **Safe by default, honest about limits.** Worktrees are not a sandbox; Orbit says so and asks for consent where it matters.

## The mission

A mission is one task carried through these stages:

| Stage | Who | Output |
|---|---|---|
| Plan | Planner (read-only) | Plan, acceptance criteria, repositories with evidence, open questions |
| Scope gate | You (only when needed) | Approved set of repositories |
| Build | Engineer in a worktree | Code and tests on an `orbit/…` branch |
| Verify | Orbit + reviewer | Real check results, review findings; automatic fix passes |
| Review gate | You | Approve (commit locally) or request changes |
| Publish gate | You | Push + pull request, or finish locally |
| Shipped | — | PR link posted back to the task |

## Entry points

- **Dashboard**: Today (what needs you, what is in flight, ready-to-run tasks), Missions, Projects.
- **Asana comment**: `/orbit run` from an authorized user. Free Asana plan, no paid rules or custom fields. Follow-up lines become extra instructions.
- **Run ready tasks**: per project, pick tasks and run them. Never the whole project automatically.
- **CLI**: `orbit run`, `orbit review`, `orbit publish` and friends.
- **Claude Code**: MCP tools (`orbit_list_asana_tasks`, `orbit_create_mission`, `orbit_review_changes`, …) and a skill.
- **Native Asana task action** (later): an App Components entry point on tasks. Requires a public app server and Asana review; see [docs/asana.md](docs/asana.md#native-run-with-orbit-in-asana-later).

## Repository routing

The difference between "an agent in a repo" and "an AI team for all my projects":

1. **Explicit mapping**: each tracker project maps to the repositories its tasks may change.
2. **Repository understanding**: Orbit keeps a concise summary per repository (stack, layout, instructions, keywords), refreshed when HEAD moves.
3. **Task routing**: the planner proposes repositories with evidence, likely files, change summary, risks and unknowns. No invented confidence numbers. Unauthorized suggestions are dropped and shown. Ambiguity means a scope question for you.

## Shareable by design (optional)

Each finished mission has a **receipt**: requirement, repositories, work, checks, findings, PR links, time and cost. The share version (Markdown and an image card) excludes repository names, task text, people and code by default.

## Non-goals for now

- Hosting code execution for you, or a multi-tenant SaaS.
- Merging pull requests or deploying.
- Replacing your tracker. Orbit reads and comments; it does not manage projects.
- Large autonomous organizations of agents.

## Success for the first release

A solo developer can, in one sitting: start Orbit, connect a repository and an Asana project, comment `/orbit run` on a task, watch the mission, review the real diff and check results, approve a pull request, and see the PR link appear on the Asana task.

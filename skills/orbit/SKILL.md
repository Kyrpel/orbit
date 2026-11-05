---
name: orbit
description: Use Orbit (the local AI dev team) through its MCP tools - find implementable Asana tasks, run a task with Orbit, check mission status, and review the real diff and check results. Use when the user mentions Orbit, missions, "run with Orbit", or wants tasks from Asana turned into pull requests.
---

# Orbit

Orbit turns a task into a reviewed pull request in the right repository. A planner proposes the repositories with evidence, an engineer works in an isolated git worktree, Orbit runs the repository's own checks, and a reviewer reads the real diff. Humans approve the scope (when ambiguous), the changes, and publishing.

The `orbit_*` MCP tools talk to the user's running Orbit. If a tool says Orbit is not running, tell the user to run `orbit start`.

## Finding work

- `orbit_list_projects` shows connected repositories and Asana projects with their repository mapping.
- `orbit_list_asana_tasks` lists open tasks; tasks without a mission are "ready". Projects without a mapped repository cannot run tasks yet; say so.

## Running a task

- From Asana: `orbit_create_mission` with `asanaTaskId` (and `projectId` when there are several projects).
- From a description: `orbit_create_mission` with `title`, `description`, and `repoIds`. Prefer exactly one repository. Use several only when the change genuinely spans them.
- After creating, report the mission id and dashboard link. Analysis takes a minute or two; offer to check back with `orbit_get_mission_status`.

## Decisions belong to the user

- Never call `orbit_approve_scope` unless the user explicitly approves in this conversation. Show the plan first with `orbit_analyze_task`.
- Publishing pull requests is not available through MCP. Point the user to the dashboard or `orbit publish <id>`.
- When reviewing (`orbit_review_changes`), treat check results as facts Orbit captured and the engineer's summary as a claim. Lead with failing checks and blocker or major findings.

## Status vocabulary

Plan → Scope approval → Build → Verify → Ready for review → PR approval → PR open / Completed. Blocked and Failed missions show a reason and can be retried or replanned in the dashboard.

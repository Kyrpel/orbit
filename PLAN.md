# Plan and checklist

Status legend: `[x]` done and tested, `[~]` implemented but not yet exercised against the real external service, `[ ]` not started.

## Milestone 1: Working foundation

- [x] pnpm monorepo, TypeScript (strict), Vitest
- [x] SQLite persistence (Drizzle schema, embedded migrations, WAL)
- [x] Fastify API with local token auth, Host/Origin checks, SSE
- [x] Dashboard (Today, Missions, mission detail, Projects, Agents, Activity, Integrations, Settings, setup wizard)
- [x] CLI (`start`, `open`, `status`, `doctor`, `repo`, `run`, mission decisions, `asana connect`, `consent`, `receipt`, `mcp`)
- [x] Local repository connection, folder scan (one level), clone from GitHub through `gh`
- [x] Real git operations (worktrees, branches, staging, diff stats, commits, push)
- [x] Dependency diagnostics (`orbit doctor`)

## Milestone 2: One real AI coding mission

- [x] `AgentRuntime` interface; scripted runtime for tests
- [x] Claude Code CLI runtime: real mission verified on Windows (planner, engineer, reviewer)
- [~] Claude Agent SDK runtime (implemented against SDK 0.3.318; needs a real `ANTHROPIC_API_KEY` run)
- [x] Isolated worktree per mission and repository; setup artifacts excluded from the change
- [x] Verification commands run by Orbit (no shell), output captured and redacted
- [x] Reviewer with structured findings; automatic fix passes
- [x] Change review and PR approval screens with real diff, checks, findings, editable PR text
- [x] Publish: push (no force) and `gh pr create`, idempotent through the outbox
- [~] Pull request against a real GitHub repository (tested with real push to a local remote and a fake `gh`)

## Milestone 3: Asana integration

- [x] Personal access token connection, verified with `GET /users/me`, stored outside the database
- [x] Workspaces, projects, tasks, stories; pagination; 401/403/404/412/429 and 5xx handling; rate budget and concurrency caps
- [x] Explicit project to repository mapping
- [x] Run a selected task from Orbit; "Run ready tasks" with explicit selection
- [x] Progress comments with idempotency markers
- [~] Verified against a real Asana workspace (needs your token; see docs/asana.md)

## Milestone 4: Trigger automation

- [x] `/orbit run`, `/orbit cancel`, `/orbit status` comments
- [x] Events API polling with persisted sync tokens; first poll never executes history
- [x] Authorized trigger users; unknown authors require approval; strangers are ignored and logged
- [x] Deduplication by comment id and one active mission per task
- [x] Reconciliation after expired tokens and on a schedule (bounded)
- [x] Restart recovery for jobs, agent runs, checks and publishing
- [x] Task edits during a mission flagged; replan creates a new requirement revision

## Milestone 5: Smart multi-project routing

- [x] Repository summaries (deterministic) refreshed when HEAD moves
- [x] Keyword evidence plus planner proposals with evidence, files, risks, unknowns
- [x] Unauthorized repository suggestions dropped and shown
- [x] Scope confirmation for ambiguous or multi-repository plans
- [x] Sequential execution and per-repository approval and publishing
- [ ] Linked PR descriptions that reference sibling PRs
- [ ] AI-written repository summaries (optional, cached)

## Milestone 6: Native Asana experience (do not start before 1–4 are verified for real)

- [ ] Asana OAuth (authorization code with PKCE; scopes `tasks:read`, `stories:read`, `stories:write`, `projects:read`, `workspaces:read`, `users:read`)
- [ ] App Components task entry point ("Run with Orbit" modal form showing task, suggested repositories, scope and budget)
- [ ] Hosted relay with request signature verification; local Orbit connects outbound
- [ ] App installation guide and Asana review submission

## Milestone 7: Open-source launch

- [x] README, LICENSE (MIT), CONTRIBUTING, SECURITY, CHANGELOG, `.env.example`, architecture, troubleshooting, Claude Code guide, Asana guide
- [~] CI workflow (typecheck, unit and integration tests, build, e2e) on Linux, macOS and Windows: written; first run happens when the repository is pushed to GitHub
- [x] Bundled CLI (`packages/cli/dist/orbit.js`) with the dashboard
- [x] Playwright end-to-end test of the dashboard flow
- [ ] Publish `orbit-dev` to npm (name available on 2026-11-04; not reserved) and document `npx orbit-dev@latest start`
- [ ] Cross-platform validation on macOS and Linux with a real sandboxed run
- [ ] Example missions gallery and contributor issue templates

## Next steps

1. Run a real Asana mission with your token (docs/asana.md).
2. Run one mission with `ANTHROPIC_API_KEY` to verify the Agent SDK runtime.
3. Point a mission at a real GitHub repository and publish a draft PR.
4. Decide the public repository name and owner, then publish to npm.

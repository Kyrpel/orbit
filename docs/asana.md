# Asana

Orbit reads tasks from Asana projects you connect, listens for `/orbit` comments, and posts progress and pull request links back to the task. It works on Asana's free plan: no paid rules, custom fields or app installation are needed.

## Connect

1. In Asana, open the developer console (`https://app.asana.com/0/my-apps`) and create a **personal access token**.
2. In Orbit: Integrations → Asana → paste the token. Orbit verifies it with `GET /users/me`, stores it in `ORBIT_HOME/secrets.json` (never in the database or logs) and authorizes you, the token owner, to trigger missions.
   - CLI alternative: `ORBIT_ASANA_TOKEN=… orbit asana connect` (the token is read from the environment or stdin, never from arguments).
3. Projects → Asana projects → **Connect project**, then choose the repositories its tasks may change.

Disconnecting deletes the token from your machine. Revoke it in Asana too if you no longer need it.

## Run a task

- **From Orbit**: Today → Ready to run, or Projects → Run ready tasks → pick tasks → Run selected.
- **From Asana**: comment on the task:

  ```
  /orbit run
  Only change the API, keep the response format.
  ```

  The first line must be exactly `/orbit run`. Following lines become extra instructions. `/orbit status` posts the current status; `/orbit cancel` cancels the active mission.

## Who can trigger missions

Only authorized Asana users (the token owner by default; add others by Asana user gid in Integrations). Comments from anyone else are ignored and recorded in Activity. If Asana does not say who wrote a comment, the mission waits for your scope approval in Orbit.

## What Orbit posts

Plain-text comments at milestones: received, plan (and whether approval is needed), ready for review, pull request opened, blocked, failed, cancelled. Each ends with a marker such as `orbit:msn_ab12cd:pr:1` so a retry after a crash finds the earlier comment instead of posting twice. Set Settings → Progress comments to *Minimal* for fewer comments.

## How detection works

- Orbit polls each connected project with the Events API (`GET /events?resource=<project>&sync=<token>`), every 30 seconds by default. The first poll only stores a sync token, so old comments never start work.
- Story-added events become trigger candidates; each comment id is processed once, and each task has at most one active mission.
- Asana delivers events at most once and sync tokens expire after at most 24 hours. When a token expires (HTTP 412) and every 15 minutes, Orbit scans the most recently active open tasks for missed commands. Asana does not update a task's `modified_at` for new comments, so this scan is best effort. Re-post the command if one was missed after long downtime.
- Task edits after a mission starts are flagged on the mission. Orbit keeps working from the snapshot taken at the start until you replan.
- Requests stay under Asana's limits (150 per minute on free plans by default; configurable for paid plans), with at most 10 concurrent reads and 4 concurrent writes, and honor `Retry-After` on 429.

## Run a genuine end-to-end test

Automated tests use a mocked Asana API. To verify the real integration:

1. Create a test project in Asana with one task, for example "Add a /health endpoint", and a short description.
2. Start Orbit with a separate data folder:
   `ORBIT_HOME=~/.orbit-asana-test orbit start` (PowerShell: `$env:ORBIT_HOME="$HOME\.orbit-asana-test"; orbit start`).
3. Connect a test repository (`pnpm demo:repo ~/orbit-demo` creates one), then connect Asana with your token and map the test project to the repository.
4. Comment `/orbit run` on the task.
5. Within about 30 seconds, check that a mission appears in Orbit and a "received" comment appears on the task.
6. Approve the changes, then publish (needs a GitHub remote) or finish locally.
7. Check that the final comment on the task contains the pull request link or the local branch name.
8. Post `/orbit run` again on the same task while the mission is active: no second mission is created.
9. From another Asana user who is not authorized, post `/orbit run`: nothing starts, and Activity shows the ignored trigger.

## Native "Run with Orbit" in Asana (later)

Asana's App Components can add an entry point on tasks (modal forms, lookups, widgets) and custom automation actions. Requirements from Asana's documentation:

- Asana sends requests directly to the app's server, so it must be reachable from the internet. Orbit runs locally, so this needs a small hosted relay that Orbit connects to outbound; Orbit will not expose your machine.
- Apps with components distributed through the App Directory go through Asana's Security + QA review. Organization-only apps are possible.
- OAuth instead of personal access tokens, with granular scopes (`tasks:read`, `stories:read`, `stories:write`, `projects:read`, `workspaces:read`, `users:read`).

The planned flow: a "Run with Orbit" modal on the task shows the task, the suggested repositories, the scope and the budget, and creates the same mission as every other entry point. Asana does not support arbitrary custom buttons in project headers, so this is a task-level entry point. Verify request-signing and timeout requirements against Asana's current App Components documentation before building it.

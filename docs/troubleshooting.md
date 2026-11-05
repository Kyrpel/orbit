# Troubleshooting

Run `orbit doctor` first. It checks Node, git, your git identity, the GitHub CLI, each agent runtime, execution mode, consent and the data folder, and prints a fix for anything wrong.

## Installing

**`corepack` fails with "Cannot find matching keyid"**
Your corepack predates npm's key rotation. Run `npm install -g corepack@latest`, or use pnpm through npx: `npx pnpm@10.34.9 install`.

**`better-sqlite3` fails to install or crashes**
Orbit uses better-sqlite3 12.x, which ships prebuilt binaries for Node 22 and 24 on Windows, macOS and Linux. Use an LTS Node version. If a prebuilt binary is unavailable, it compiles from source and needs build tools (Visual Studio Build Tools on Windows, Xcode Command Line Tools on macOS, `build-essential` on Linux).

**`ERR_REQUIRE_ESM` on start**
Some dependency expects Node 22.12+. Upgrade Node (24 LTS recommended).

## Starting

**"Port 7420 is already in use"**
Orbit may already be running: `orbit status`. Or start on another port: `orbit start --port 7430`.

**The dashboard says "Sign in to Orbit"**
Run `orbit open` for a signed-in link. The cookie lasts 30 days.

## Missions

**Blocked: "The agent sandbox could not start on this machine"**
You are in sandbox mode on a system where Claude Code's sandbox is unavailable (native Windows today). Switch Settings → Execution to **Trusted-local** and give consent, or run Orbit on macOS, Linux or WSL2. Then press **Retry**.

**Blocked: "… needs your consent to run commands on this machine"**
Setup and verification commands run your repository's scripts against agent-written code. Allow it in Settings → Execution, or run `orbit consent`.

**Blocked: "Claude Agent SDK is not ready: Set ANTHROPIC_API_KEY"**
Set the key in the environment you start Orbit from, or switch the runtime to Claude Code CLI.

**Blocked: "Claude Code is installed but not logged in"**
Run `claude` once and sign in.

**A setup command fails (for example `npm ci`)**
Fix the command in Projects → Checks, or make sure the lockfile is committed. Commands run without a shell: `&&`, `|` and redirects are rejected; add separate commands instead.

**Checks fail that pass on your machine**
Verification runs in the mission worktree with `CI=1`, without your Anthropic, GitHub or Orbit tokens in the environment. Tests that need extra environment variables should read them from your normal shell environment, not from those tokens.

**The change includes unrelated files**
Files created by setup commands are excluded automatically, as are `node_modules`, `.venv` and similar folders. Add generated folders to your `.gitignore` for anything else.

**Commit failed: identity unknown**
`git config --global user.name "Your Name"` and `git config --global user.email you@example.com`.

## Publishing

**"GitHub CLI is not logged in"**
`gh auth login`, then publish again. Publishing is idempotent: Orbit checks for an existing branch and pull request before creating anything.

**Push rejected**
The remote branch has different commits. Orbit never force-pushes. Delete or rename the remote branch, or request changes so the engineer continues on a fresh commit.

## Asana

**Comments with `/orbit run` do nothing**
- The project must be connected in Orbit and have `/orbit run comments` enabled.
- The comment's first line must be exactly `/orbit run`.
- The author must be authorized (Integrations → Asana). Ignored triggers appear in Activity.
- Orbit polls every 30 seconds by default; use the refresh button on the project to check now.
- After long downtime (Asana sync tokens last up to 24 hours), Orbit scans recent tasks; very old missed comments may need to be re-posted.

**401 / 403 from Asana**
The token was revoked or lacks access to the project. Reconnect Asana with a new token.

**429 from Asana**
Orbit waits for `Retry-After` and retries. On paid Asana plans you can raise the request budget in Settings.

# Security

Orbit lets AI agents modify code on your machine and, with your approval, publish it. Security is part of the product, not an add-on.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). Include steps to reproduce and the Orbit version (`orbit --version`). We aim to acknowledge reports within a few days.

## Threat model

| Asset | Threat | Mitigation |
|---|---|---|
| Your repositories (Autopilot) | An agent changes the wrong repository or your working copy | Repository allowlist (`allowModify`); planner suggestions outside the allowlist are dropped and shown; work happens only in a dedicated worktree on an `orbit/…` branch; your checkout and default branch are never written |
| Your repositories (workspace) | A session agent you are working with does more than you asked | Sessions edit the real project you opened, like Claude Code in a terminal, and only projects marked as modifiable; in *Ask first* every command that is not known to be read-only waits for your approval, in *Auto-accept* Claude Code's safety classifier decides and Orbit's deny rules still apply; Codex runs in its own sandbox and must ask (live, in Orbit) for anything the sandbox blocks |
| Your remote and collaborators | Unreviewed code is pushed | Autopilot: pushes and PRs happen only after explicit approval; no merge; the engineer cannot run `git push`, `git commit`, `gh` or publish commands. Workspace: the session agent commits and pushes only when you ask, through the same command approval. Everywhere: force-push, history rewrites (`reset --hard`, `rebase`), git config and remote changes, `gh`, `sudo`, `ssh` and package publishing are refused |
| Your machine | Agent or agent-written code runs harmful commands | *Sandbox* mode requires Claude Code's OS sandbox and fails closed; *trusted-local* mode and all setup/verification commands require explicit, revocable consent that states clearly this is not a sandbox |
| Your credentials | Tokens leak through logs, prompts, commits or PR text | Tokens stored in `ORBIT_HOME/secrets.json` (owner-only permissions on POSIX), never in the database; registered secrets and common token formats are redacted from everything Orbit stores or sends; diffs and PR text are scanned before commit and publish; agents get an allowlisted environment without GitHub, Asana, npm or Orbit tokens; verification commands do not receive Anthropic or GitHub tokens |
| Orbit's local API | Another website or local user drives Orbit | Binds to loopback; random token required for every API route; dashboard sessions use an HttpOnly SameSite=Strict cookie; foreign `Host` headers (DNS rebinding) and cross-origin writes are rejected; sign-in redirects are same-site only |
| Trigger channel | Anyone who can comment in Asana starts work | Only authorized Asana users trigger missions; unknown authors require approval in Orbit; others are ignored and audited; each comment is processed once |
| Skills and plugins | A Claude Code plugin runs harmful hooks or MCP servers | Plugins are installed only when you click Install (or confirm `/skills`); Orbit shows a plugin's hooks and MCP servers and warns before you keep it; plugins that install by running a marketplace-declared command are left to Claude Code's own `/plugin` review; only marketplaces you add are searched |
| Prompt injection | Task text, comments or repository files instruct the agent to break rules | All such content is wrapped and labeled as untrusted; hard limits (allowlists, tool policy, gates, secret scanning) are enforced in code, not by prompts |
| Public repositories | Private task details appear in a public PR | Task links and requirement text are included in PR bodies only for private or internal repositories, unless you opt in |

## Honest limits

- **Git worktrees are not a security boundary.** They isolate changes, not processes.
- **The tool policy is defense in depth.** Shell deny rules can be bypassed by a determined agent. The real boundary is the OS sandbox, or your informed consent in trusted-local mode.
- **Verification commands run your repository's scripts** against code an agent wrote, with your user permissions. That is why they need consent.
- **Native Windows**: Claude Code's sandbox is not active on native Windows today. Missions there need trusted-local mode.
- **Claude Code CLI runtime** inherits whatever configuration your `claude` installation has at the managed-settings level. For Autopilot, Orbit passes `--restricted`, an explicit tool list and deny rules, and ignores user and project settings files. Workspace sessions load your own user settings, skills and plugins (as your terminal does) but still ignore settings files inside projects.

## Credentials Orbit never handles

- Claude subscription credentials: the Agent SDK runtime requires an API key or cloud provider credentials; the CLI runtime runs your own `claude` without Orbit reading its login.
- GitHub tokens: Orbit uses your `gh` session; it never reads or stores the token.

## Data

Everything lives under `ORBIT_HOME` (default `~/.orbit`): the SQLite database, worktrees, cloned repositories, `auth.json` (local API token) and `secrets.json`. Delete the folder to remove all Orbit data. Disconnecting Asana deletes the stored token; revoke it in Asana as well.

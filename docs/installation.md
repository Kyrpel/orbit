# Installation

## Requirements

| Tool | Why | Check |
|---|---|---|
| Node.js 22.11+ (24 LTS recommended) | Runs Orbit | `node -v` |
| git 2.28+ | Worktrees, branches, commits | `git --version` |
| One AI runtime | The planner, engineer and reviewer | see below |
| GitHub CLI (optional) | Pushing branches and opening pull requests | `gh auth status` |
| Asana account (optional) | Running tasks from Asana | — |

AI runtime options (pick one in the setup wizard or Settings):

- **Claude Code CLI**: install Claude Code and sign in once by running `claude`. Orbit runs it headless with your own login.
- **Claude Agent SDK**: set `ANTHROPIC_API_KEY` in the environment you start Orbit from (or configure Bedrock, Vertex AI or Microsoft Foundry).
- **Scripted demo**: no AI; useful for trying the flow.

## From source

```bash
git clone <repository url> orbit
cd orbit
corepack enable
pnpm install
pnpm build
pnpm orbit start
```

`pnpm orbit start` prints a sign-in link and opens it. Keep the terminal open; `Ctrl+C` stops Orbit. Work in progress survives restarts.

Optional global command:

```bash
cd packages/cli
npm link        # now `orbit` works in any terminal
```

## Data location

Orbit stores everything in `~/.orbit` (Windows: `%USERPROFILE%\.orbit`). Change it with `ORBIT_HOME`. Worktrees for missions live in `~/.orbit/worktrees`, clones made by Orbit in `~/.orbit/repos`.

## First run

1. **Check your tools**: git, git identity, GitHub CLI.
2. **GitHub**: `gh auth login` if you want pull requests.
3. **Repositories**: add a path, scan a folder (one level deep), or clone from GitHub.
4. **Asana**: paste a personal access token, or skip.
5. **Map projects**: choose which repositories each Asana project may change.
6. **Your AI team**: runtime, execution mode and consent for local commands.
7. **First mission**: a small, concrete change in one project.

## Windows notes

- Claude Code's OS sandbox is not available on native Windows yet. Use **Trusted-local** mode with consent, or run Orbit inside WSL2 for sandboxed agents.
- Claude Code needs Git for Windows (Git Bash) for its shell tool.
- Long paths: worktrees live under `~/.orbit/worktrees/<repo>/<id>`; if a repository has very deep paths, enable `git config --global core.longpaths true`.

## Updating

```bash
git pull
pnpm install
pnpm build
```

Database migrations run automatically on start.

# Contributing to Orbit

Thanks for helping. Orbit aims to stay small, safe and understandable in minutes, so please read [PRODUCT.md](PRODUCT.md) and [ARCHITECTURE.md](ARCHITECTURE.md) before larger changes, and open an issue first for anything that changes the mission flow or the safety model.

## Setup

- Node.js 22.11 or newer (24 LTS recommended)
- git 2.28 or newer
- pnpm 10 through corepack: `corepack enable`
  - If corepack fails with `Cannot find matching keyid`, your corepack is too old: `npm install -g corepack@latest`, or run pnpm directly with `npx pnpm@10.34.9 <command>`.

```bash
pnpm install
pnpm dev          # API :7420 (tsx watch) + dashboard :5173; open the printed sign-in link
```

Use a separate data folder while developing so you do not mix test missions with your real ones:

```bash
ORBIT_HOME=~/.orbit-dev pnpm dev          # macOS/Linux
$env:ORBIT_HOME="$HOME\.orbit-dev"; pnpm dev   # PowerShell
```

`pnpm demo:repo <folder>` creates a disposable repository with tests and a local remote.

## Checks

```bash
pnpm typecheck
pnpm test          # unit + integration (real git in temp folders) + server security
pnpm test:e2e      # Playwright; first run: npx playwright install --only-shell chromium
pnpm build
```

All of these run in CI on Linux, macOS and Windows.

## Guidelines

- **Run commands without a shell.** Use the `CommandRunner` (execa) with argv arrays. Never interpolate untrusted text into a command.
- **Every state change goes through `MissionService.transition`.** Add new transitions to `MISSION_TRANSITIONS` deliberately and test them.
- **Outward actions go through the `Outbox`** with an idempotency key and a `check` that can detect an earlier success.
- **Treat task text, comments, repository files and agent output as untrusted.** Enforce limits in code.
- **Redact.** Anything stored or sent outward passes through `redactSecrets`.
- **Mock external APIs in tests, never in product code.** Do not present mocked behavior as a real integration.
- **Keep the core provider-neutral.** Tracker-specific code lives in its own package behind `TaskProvider`.
- **UI copy**: plain verbs, sentence case, say what a button does. Amber (signal) is reserved for human decisions.

## Adding a task tracker

1. Create `packages/integrations-<name>` implementing `TaskProvider` (see `packages/integrations/src/index.ts`).
2. Map its errors to `ProviderError` kinds.
3. Implement `pollTriggers` with deduplication keys that are stable across redeliveries.
4. Register it in `defaultProviderFactory` and add a connect flow.
5. Add tests with a mocked API.

## Adding an agent runtime

Implement `AgentRuntime` in `packages/agents`: report availability honestly, enforce read-only versus workspace-write access, return normalized results, and never claim sandboxing you do not have.

## Commits and pull requests

Small, focused pull requests with tests. Describe user-visible changes in `CHANGELOG.md` under "Unreleased".

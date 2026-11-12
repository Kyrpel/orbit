<p align="center">
  <img src="docs/assets/orbit-mark.svg" width="88" height="88" alt="Orbit logo" />
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  <strong>All your projects. One place. An AI team that works the way you do.</strong><br />
  Open every project side by side and let Claude, Codex, Cursor, OpenRouter models or your own model change them,<br />
  like a wall of Claude Code terminals, with a team of agents for planning, reviewing, security and better tasks when you want them.
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0b7c71" />
  <img alt="Node.js 22.11+" src="https://img.shields.io/badge/node-22.11%2B-1c2333" />
  <img alt="Local first" src="https://img.shields.io/badge/runs-on%20your%20machine-f3ae3d" />
  <img alt="Status: early" src="https://img.shields.io/badge/status-0.1%20early-5d6677" />
</p>

---

## What Orbit is

![Orbit working across projects — looping demo at 2× speed](docs/assets/orbit-demo.gif)

[Watch the full-resolution video — 26 seconds at 2× speed](docs/assets/orbit-demo-2x.mp4).

Orbit is a local app for solo and indie developers who work on several projects at once. You open one dashboard and:

- **work in all your projects at once**, each in its own live pane, with an agent that reads and edits it directly;
- **see every step** the agent takes and approve commands with one click, or let it run on its own;
- **paste screenshots and long logs**, talk to the agent while it works, and use the slash commands and shortcuts you know from Claude Code;
- **give your agents any skill** from Claude Code's marketplaces (about 3,900 plugins) in one click;
- **hand whole tasks to Autopilot**, where a small team of agents plans, builds, reviews and checks security before you approve anything;
- **use the AI you already pay for**: your Claude Code plan and your Codex (ChatGPT) login, with automatic switching when one hits its usage limit;
- **bring other models**: hundreds of models through OpenRouter (DeepSeek, Qwen, GPT, Gemini…), or any open model from Hugging Face on a GPU you rent by the hour, each with your own instructions;
- **pick up where you left off**: agents can look up what you did in Claude Code or Codex outside Orbit, in any folder.

Everything runs on your machine with your own logins and keys. There is no hosted service and no Orbit account.

## The workspace

The workspace is the home screen. Open your projects and they sit **side by side**, each in its own pane, so you watch them all at once instead of switching between terminals. Choose Auto, 2, 3 or 4 columns; narrow windows adapt to one column. A pane waiting for you gets an amber edge. **One at a time** shows a single project full size.

There are two looks, switched in the top bar:

- **Terminal** (the default) draws every pane like Claude Code in a terminal: `>` for your messages, `⏺ Bash(npm test)` steps with `⎿` results and edit diffs under them, the boxed prompt and its mode line.
- **Light** is a white, friendly version of the same thing, with the same features.

| In a pane you can | |
|---|---|
| **Tell the agent what to change** | It edits the real files, like Claude Code in a terminal, and remembers the conversation. |
| **Talk to it while it works** | A message sent mid-answer is read at the agent's next step. Esc stops it; Ctrl+Enter interrupts and sends. |
| **Paste images and long text** | Ctrl+V a screenshot (or drop an image) and it becomes `[Image #1]`; Claude or Codex sees it. Long pastes fold to `[Pasted text #1 +42 lines]` and the full text is sent. |
| **Watch it work** | Every step with its result: the command output, `Read 120 lines`, or an edit's changed lines. |
| **Choose how commands run** | Shift+Tab cycles **Ask first** (you approve each new command), **Auto-accept** (commands run on their own; a safety check still blocks risky ones), **Plan** (the agent researches and proposes a plan, changes nothing until you approve) and **Read-only**. |
| **Pick the AI, model and effort** | Auto, Claude, Codex, Cursor, OpenRouter or Hugging Face, with each provider's models and supported effort choices, per pane. |
| **Point at files and run commands yourself** | `@` completes the project's files and folders. `!npm test` runs a command in the project right away; the agent hears about it with your next message. |
| **Rewind and compact** | `/rewind` goes back to before one of your messages and restores the files, the conversation or both. `/compact` has the agent summarize the session and continue from the summary with a fresh context. |
| **Use slash commands** | `/model`, `/effort`, `/ai`, `/mode`, `/plan`, `/resume`, `/past`, `/clear`, `/compact`, `/rewind`, `/context`, `/cost`, `/init`, `/changes`, `/commit`, `/security`, `/skills`, `/improve`, `/help`. Type `/` to see them, `?` for shortcuts. |
| **Review and commit** | The Changes panel shows every changed file and the diff, with a Commit button. Or ask the agent to commit and push for you. |
| **Check security** | One click asks the Security reviewer to look over your uncommitted changes. |

## Skills

The **Skills** page searches everything Claude Code's marketplaces offer (Anthropic's official marketplace and its plugin directory, about 3,900 plugins) plus your own skill folders. Install, turn on or off, or remove a plugin in one click, or type `/skills <search>` in any session.

It is Claude Code's own plugin system, so whatever you install also works in your terminal, and your Claude sessions use it from their next message. **What's inside** shows a plugin's skills, agents, hooks, MCP servers and how many tokens it adds to every session, with a warning when it runs code on your computer. You can add any marketplace you trust.

## Your agents

Each agent has one job and the AI that suits it. You can change the AI, model and effort for each one on the **Agents** page; **Settings** shows them all at a glance.

| Agent | Job | Used |
|---|---|---|
| **Session agent** | Works with you directly in a project | Every message in the workspace |
| **Prompt engineer** | Rewrites rough tasks into clear ones with acceptance criteria | When you click *Improve* or type `/improve` (workspace or Asana task) |
| **Security reviewer** | Looks for leaked secrets, injection, missing auth checks, risky dependencies | *Check security*, and every Autopilot task |
| **Planner** | Reads the task and your code, picks the right project, writes the plan | Autopilot |
| **Engineer** | Builds the plan in a separate copy of the project and adds tests | Autopilot |
| **Reviewer** | Checks the real diff against the plan and the test results | Autopilot |

Session agents finish the job themselves: they build, test and check their own work, and when you ask them to commit, push or "make it live" they run git themselves instead of handing you a list of steps.

On **Auto**, the reviewers use a different AI from the one that wrote the code, so every change gets a second opinion. If an AI is not ready or hits its usage limit, Orbit hands the step to the other one and says so.

## Other AIs: OpenRouter and your own models

**Cursor** runs through its own CLI and your Cursor subscription. Install the [Cursor CLI](https://cursor.com/docs/cli/installation), run `cursor-agent login`, then refresh the Cursor card on **Agents**. Choose which account models appear in Orbit and add instructions for each. Pick Cursor in a session's AI menu. Orbit keeps each session's settings and chat separate, preserves your deny rules, and ignores project permission overrides. Cursor is available for local sessions; it does not provide Orbit's verified OS sandbox for Autopilot.

Besides Claude and Codex, a session can use two more AIs. Pick them next to Auto, Claude and Codex in a session (or with `/ai`), then the model with `/model`. Both run inside Claude Code's tools with their own key: your Claude login is never used, and nothing in an OpenRouter or Hugging Face session falls back to Claude or Codex (not the answers, not the next-message suggestions, not `/improve`).

**OpenRouter** (DeepSeek, Qwen, Hermes, GPT, Gemini and hundreds more)
1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. On the **Agents** page, paste it into the OpenRouter card and click Connect.
3. Add models by pasting their openrouter.ai link. Orbit shows each model's price, context size, and whether it can use tools: models without tool support are marked *chat only* (they can talk, but not read or change your files).

**Hugging Face Inference Endpoints** (any GGUF model, on a GPU you rent by the hour)
1. Paste a Hugging Face model link into the Hugging Face card on the **Agents** page. Orbit reads its files and Hugging Face's GPU list and shows which GPUs each file fits on, with the price per hour. No token is needed to look.
2. To create the endpoint, connect a Hugging Face token with write access ([huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)) and add a payment method to your Hugging Face account.
3. Pick the file and GPU and click Create. The endpoint is private to your token, runs llama.cpp with a 64k-token context and tool use, and goes to sleep after the minutes you choose without use, so it only costs while it is awake. A session wakes it when needed (a few minutes) and tells you while it waits. Pause or delete it from the same card.

Each OpenRouter model and each endpoint can have your own **instructions**, a master prompt that goes into its system prompt in every session.

Keys and tokens are stored only in Orbit's data folder on your computer (`~/.orbit/secrets.json`), never in the project, the database or the logs, and are only ever sent to the service they belong to.

## Your sessions from Claude Code and Codex

Session agents can look up what you did in Claude Code or Codex outside Orbit, in any folder: "like last time" or "which folder was that in?" just works. Orbit keeps short transcripts of those sessions in `~/.orbit/past-sessions` (what was asked and answered, the commands that ran and the files that changed; no command output, thinking or images; secrets removed) and gives agents that folder read-only. `/past <search>` puts one session into your message, and `/resume` also lists this project's outside sessions. Switch it off in **Settings**.

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

Optional, for more models: an [OpenRouter](https://openrouter.ai/keys) API key, or a [Hugging Face](https://huggingface.co/settings/tokens) token with billing set up. You add them on the **Agents** page once Orbit is running.

```bash
git clone https://github.com/Kyrpel/orbit.git
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

## Keyboard

| Key | In the prompt |
|---|---|
| `Enter` / `Shift+Enter` | Send / new line |
| `/` | Commands |
| `Shift+Tab` | Ask first → Auto-accept → Plan → Read-only |
| `Esc` | Stop the agent (or close a menu) |
| `Ctrl+Enter` | Interrupt the agent and send right away |
| `↑` | Your last message |
| `Tab` | Take the suggested next message |
| `@` | Mention a file or folder |
| `!` | Run a command yourself |
| `?` | Shortcuts |
| `Ctrl+V` | Paste an image or a long text |

In permission prompts and pickers: `↑` `↓` and `Enter`, or press the option's number.

## Save tokens, orchestrate smart

- **Everyday changes: use the workspace.** That is one agent, about the same cost as Claude Code in a terminal.
- **One topic per session.** `/clear` starts a new session for a new topic; long sessions carry more context.
- **Match the model and effort to the job**, per pane or on the Agents page: a fast model and low effort for routine work, the strongest one for hard problems.
- **Auto-accept** saves the extra round trip each *Allow* click costs.
- **Keep only the skills you use.** Every installed plugin adds tokens to every session; *What's inside* shows how many.
- **Spread the load:** give the Reviewer or Prompt engineer to Codex so both subscriptions share the work.
- **Autopilot is the full team** (at least four agent runs per task). Lower *Automatic fix passes* in Settings, or turn off the security review for projects that do not need it.

## Safety

Orbit lets AI change code, so the guardrails are built in:

- **You decide what ships.** Autopilot never commits, pushes or publishes without your click, and Orbit never merges. In the workspace an agent commits or pushes only when you ask; in *Ask first* each of those commands waits for your OK.
- **Hard limits in every mode.** Force pushes, rewriting git history, changing git settings or remotes, publishing packages, `gh`, `sudo` and `ssh` are always blocked, and agents cannot read `.env` or key files.
- **Commands need your OK** in *Ask first*; in *Auto-accept* a safety check blocks risky ones. Codex runs inside its own sandbox; when it needs something the sandbox blocks (a commit, a push), Orbit asks you first, or applies its own rules in *Auto-accept*.
- **Your projects stay yours.** Settings files inside a project cannot loosen Orbit's rules. Autopilot works in a separate copy of the project.
- **Your credentials stay where they are.** Orbit uses Claude Code's and Codex's own logins and never reads them. Your OpenRouter, Hugging Face and Asana keys live in `~/.orbit/secrets.json`, outside your projects, are only sent to their own service, and output is scanned and redacted for secrets. An OpenRouter or Hugging Face session never uses your Claude login.
- **Rented GPUs only cost while awake.** Hugging Face endpoints Orbit creates sleep after the minutes you choose without use; Orbit shows the hourly price before you create one, and you can pause or delete them from the Agents page.
- **Skills are your choice.** Plugins can bring hooks and MCP servers that run on your computer; Orbit shows them before you keep a plugin. Install only what you trust.
- **Local only.** The API listens on 127.0.0.1 and requires a random token.

More in [SECURITY.md](SECURITY.md).

## Connect Asana (optional)

Turn Asana tasks into finished work:

1. **Integrations → Asana**: paste a personal access token (Asana → developer console → *Create new token*).
2. **Projects → Asana projects → Connect project**: pick the Asana project and the code projects its tasks may change.
3. Write the task in Asana as usual. Click **Improve** in Orbit to have the Prompt engineer rewrite it with clear acceptance criteria, then **Update in Asana**.
4. Start it: comment `/orbit run` on the task (lines below it become extra instructions), or pick it under **Autopilot → Ready to run**.
5. Within about 30 seconds Orbit comments on the task, runs Autopilot, and posts the pull request link when you have approved the change. `/orbit status` and `/orbit cancel` work too.

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
packages/core       Sessions, Autopilot engine, orchestrator, workspace, skills,
                    OpenRouter, Hugging Face endpoints, your past sessions
packages/agents     Claude Code, Claude Agent SDK and Codex runtimes, model gateways,
                    prompts, tool policy, plugins
packages/git        git and gh wrappers
packages/database   SQLite schema and migrations
packages/integrations-asana   Asana connector
packages/cli        The `orbit` command
packages/mcp        MCP server for Claude Code
```

## License

[MIT](LICENSE)

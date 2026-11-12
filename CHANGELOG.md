# Changelog

All notable changes to Orbit are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Resolve Hugging Face model metadata before listing files so missing-model errors are consistent.

- Authenticate encoded API paths using Fastify's matched route; reject off-site sign-in redirects using backslashes or control characters.
- Preserve Cursor user deny rules, enforce disabled web fetching, ignore repository permission overrides, and fail closed when OS isolation is requested.
- Update vulnerable static-serving and test dependencies; use patched esbuild in the CLI build.

- Hugging Face resume errors report a missing payment method when the service returns a billing-related 403, instead of incorrectly asking for a different token.
- Hugging Face sessions with Qwen and other strict llama.cpp chat templates combine Claude Code's system instructions before sending them, fixing the "System message must be at the beginning" error while preserving tools and streaming.

### Added

- A looping GIF of the workspace demo, embedded directly in the README.

- Cursor CLI sessions using your Cursor subscription, account models, and per-model instructions.
- Auto, 2, 3 and 4-column workspace layouts and a 2× workspace video in the README.

- Mission engine with an explicit state machine, durable SQLite job queue, restart recovery and an idempotent outbox for pushes, pull requests and task comments.
- Planner, engineer and reviewer roles with structured outputs; automatic fix passes on failing checks or blocking review findings.
- Runtimes: Claude Agent SDK, Claude Code CLI (headless) and a scripted demo runtime.
- Isolated git worktrees per mission; setup artifacts kept out of the change; secret scanning before commit and publish.
- Repository routing: project mapping, repository summaries, keyword evidence and planner proposals with explicit scope approval.
- Asana: personal access token connection, project mapping, `/orbit run|cancel|status` comments through the Events API, reconciliation, progress comments, "Run ready tasks".
- Dashboard: Today, Missions with live trajectory and timeline, diff viewer, checks, review findings, approval rail, Projects, Agents, Activity, Integrations, Settings and a setup wizard.
- CLI `orbit` and an MCP server for Claude Code.
- Mission receipts with a privacy-safe share version and image card.
- Automatic runtime (default): your Claude Code plan when available, otherwise an API key.
- Per-role reasoning effort (low to max); the engineer defaults to Extra high.
- Blocked missions name their cause and offer a one-click fix ("Allow and retry"); scope approval warns about required machine permissions up front.
- Live tab on missions: what each agent is doing right now, step by step, with its to-do list, failed steps and your checks.
- Codex CLI runtime (`codex exec --json`, your ChatGPT login), always sandboxed: read-only for planning, review and Ask; workspace-write without network for the engineer.
- AI team orchestrator: Planner, Engineer, Reviewer and Assistant each pick Claude or Codex (or Auto). Auto has a different AI review the engineer's work, and steps switch to the other AI when one is not ready or hits its usage limit.
- Ask: chat with the Assistant about any or all of your projects. It reads the code (never writes), shows the files it looked at, and can turn an answer into a mission in one click. Quick-ask box on Today.
- Configurable worktree folder (`execution.worktreeRoot`), with a one-click fix on Windows where Codex cannot run Node inside the user folder.
- Workspace (new home screen): pick any project and work with Claude or Codex directly in it, several projects at once in tabs with live status lights (working, needs your OK, finished). Agents edit the real files, keep their session between messages, and ask before running commands (Allow and continue). Each tab picks its AI; a Changes panel shows the diff with Commit and Check security.
- Working sessions load your own Claude Code user settings and skills (design skills included) while still ignoring settings files inside projects; the session agent is told to use the design skill that fits each project.
- Security reviewer: a sixth agent that checks every Autopilot change (critical and high findings go back to the engineer) and your workspace changes on request.
- Prompt engineer: rewrites rough Asana tasks into clear ones with acceptance criteria (review, edit, then Update in Asana) and improves requests in the workspace (Improve).
- Settings shows all your agents and the AI each one uses. Missions are now called Autopilot tasks in the interface.
- New light, friendlier interface: white work surfaces, a top bar, plain language, and colour with meaning (amber for you, teal for an AI at work).
- Talk to the agent while it works, like Claude Code: a message sent mid-answer is read at the agent's next step (Claude Code via live stream-json input, Codex via its app-server `turn/steer`). Send now interrupts; messages that cannot be delivered yet are queued and sent together when the answer ends.
- Codex on Windows uses the "unelevated" sandbox, so tools installed in the user folder (Python, Node) run while network, git writes and writes outside the project stay blocked.
- Pick the model per workspace tab (Claude or Codex models; Default = the session agent's model). Working sessions have no time, step or budget cap per message, like Claude Code; Autopilot keeps its limits.
- Pick the reasoning effort per workspace tab (Low to Max, for Claude and Codex; Default = the session agent's effort).
- Side by side (the new default): every open project in its own live pane at once, each with its steps, Allow buttons, follow-ups, Changes and its own AI, model and effort. A pane that needs you gets an amber edge. "One at a time" keeps the full-size tabs.
- Two looks, switched in the top bar: Terminal (the default) and Light (the white, friendly workbench). In Terminal, every workspace pane is drawn like Claude Code in a terminal: `>` for your messages, `⏺ Tool(target)` steps with `⎿` results and edit diffs under them, the boxed prompt with its mode line (Shift+Tab cycles Ask first, Auto-accept and Read-only), slash commands (`/model`, `/effort`, `/ai`, `/resume`, `/clear`, `/changes`, `/commit`, `/security`, `/improve`, `/help`…), numbered permission prompts, `✻ Working… (esc to interrupt)`, Esc to stop and Ctrl+Enter to interrupt and send.
- Agents in working sessions do the whole job themselves: when you ask them to commit, push, ship or deploy, they run git themselves (with your approval in Ask first) and check the result, instead of handing you steps. Force pushes, history rewrites, git settings and publishing stay blocked. Autopilot keeps its own rules (Orbit commits and pushes after your approval).
- Codex can ask, mid-answer, to run what its sandbox blocks (a commit, a push, a download). Orbit asks you live (Yes / Yes for this session / No); in Auto-accept, Orbit's own rules decide.
- Working sessions record what each step produced (the first lines of command output, `Read 120 lines`, an edit's changed lines), so you can see results the way Claude Code shows them.
- Paste or drop images into a session prompt (Ctrl+V), as in Claude Code: they show as `[Image #1]` in your message and Claude or Codex sees them. Long pastes fold to `[Pasted text #1 +42 lines]` and the full text is sent. Messages may now be up to 200,000 characters.
- Both looks share the same prompt: slash commands and pickers, Shift+Tab, Esc, Ctrl+Enter, ↑, `?`, image paste and Improve. Light shows them in the white design (menus, image thumbnails), plus each step's output and an edit's diff (`+3 −1`, click `diff`).
- Skills: search every Claude Code plugin your marketplaces offer (about 3,900 from Anthropic's official marketplace and plugin directory, plus any marketplace you add) and your own skill folders, then install, turn on or off, or remove them in one click. It is Claude Code's own plugin system, so installs work in your terminal too and your Claude sessions use them from their next message. "What's inside" shows a plugin's skills, agents, hooks, MCP servers and token cost, with a warning when it runs code. `/skills <search>` does the same from any session prompt.
- Next-message suggestions, like Claude Code's: after each answer a small, fast model (Haiku) guesses what you will type next and shows it greyed out in the prompt; Tab uses it. On by default, switchable in Settings.
- Replies to messages you sent mid-answer are marked "Reply to you" and stay visible; an open dashboard offers Reload when Orbit was updated, and dashboard files are served per request so rebuilds need no restart.
- Codex's built-in web tool now reads like Claude Code's: a page Codex opens shows as `Fetch(url)` with the real address, a search as `Web Search("…")` (before, an opened page was shown as a search for its own address).
- "Allow agent web access" now controls Codex's own web tool too (`web_search` is `live` when on, `disabled` when off). Before, Codex could search and open pages whatever the switch said.
- Plan mode, like Claude Code's: Shift+Tab (or `/plan`) cycles Ask first, Auto-accept, Plan and Read-only. In Plan the agent only reads and proposes a plan; when it is done you choose "Yes, auto-accept", "Yes, ask first" or "Keep planning". Works for Claude and Codex.
- `/compact [focus]`: the agent writes its own summary of the session and continues from it in a fresh context (for Claude and Codex). `/context` shows how full the context window is, `/cost` what the session has used (Claude reports money, Codex tokens), `/init` has the agent write CLAUDE.md or AGENTS.md.
- `/rewind`: go back to just before one of your messages. Before every editing turn Orbit saves the project's files (as an unreferenced git commit, with a copy of the index, so your staging area, branches and HEAD are never touched); rewinding restores the files, the conversation, or both, and puts your message back in the prompt. Commits the agent made stay.
- `@` in the prompt completes the project's files and folders (best match first, no dependency folders); `!command` runs a command in the project right now with PowerShell or sh (trimmed environment, 2-minute limit, redacted output) and the agent hears about it with your next message.
- Claude sessions can use subagents (the Agent tool, same tools and permission rules as the session) and invoke installed skills. An editing session loads your own MCP servers (user settings, plugins, claude.ai connectors). A project's own `.mcp.json` never loads, and read-only sessions (Ask, Plan) get no MCP servers.
- Model, AI and effort menus explain that changing them during a run applies to the next run; messages sent into the active run keep its original model.
- Your Claude Code and Codex sessions from outside Orbit (terminal, desktop app, editor; any folder, not only connected projects) are available to session agents. Orbit reads the CLIs' own session files, keeps short transcripts in `~/.orbit/past-sessions` with an `INDEX.md` (what was asked and answered, commands that ran, files that changed; no command output, thinking or images; secrets redacted), and gives agents that folder read-only, so "like last time" or "which folder was that in?" just works. `/past <search>` puts one session into your message as `@past:claude/1a2b3c4d` (its transcript goes with it), and `/resume` also lists this project's outside sessions to continue in a new session. Orbit's own runs are left out. Switchable in Settings.
- Hugging Face Inference Endpoints as an AI in sessions: paste a Hugging Face model link on the Agents page and Orbit lists its GGUF files and the GPUs each fits on (with a 64k-token context), with hourly prices, no token needed. With a write token it creates a private llama.cpp endpoint (tool use on, sleeps after the minutes you choose), wakes it when a session needs it (saying so while it waits), and pauses, resumes or deletes it. Sessions on it run in Claude Code's tools through llama.cpp's Anthropic-compatible API with your Hugging Face token. Clear messages for a missing payment method, a token without write access, or an endpoint that ran out of memory.
- OpenRouter as a fourth AI in sessions (Auto · Claude · Codex · OpenRouter, also `/ai openrouter`): connect an OpenRouter API key on the Agents page (checked with OpenRouter, kept in Orbit's secrets file, only sent to OpenRouter), then pick its model in the Model menu or `/model`; each AI lists only its own models, and an OpenRouter session never switches to another AI on its own. Each OpenRouter model can have your own instructions (a master prompt, up to 40,000 characters; long system prompts reach Claude Code as a file) that go into its system prompt in every session. Nothing in an OpenRouter session uses Claude or Codex: next-message suggestions and /improve run on the session's own model, and the model is told it is not Claude. DeepSeek V4.1 Flash (`deepseek/deepseek-v4.1-flash-1017`) and Hermes 4 405B (`nousresearch/hermes-4-405b`) are there from the start; add more by pasting an openrouter.ai link. Claude Code runs them with `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` pointed at OpenRouter, your Claude login and other credentials left out, Claude's thinking setting off, and the chosen model for background calls and subagents too. Models OpenRouter lists without tool support (Hermes 4 405B) run "chat only" with no tools. Each OpenRouter model keeps its own agent session; switching model starts a fresh one with the conversation so far.
- Single-project choice by default when starting a mission; changes spanning several projects are an explicit opt-in.

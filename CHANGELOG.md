# Changelog

All notable changes to Orbit are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
- Replies to messages you sent mid-answer are marked "Reply to you" and stay visible; an open dashboard offers Reload when Orbit was updated, and dashboard files are served per request so rebuilds need no restart.
- Single-project choice by default when starting a mission; changes spanning several projects are an explicit opt-in.

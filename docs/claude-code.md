# Using Orbit from Claude Code

Orbit ships an MCP server so you can talk to it from Claude Code (or any MCP client). The tools call your running Orbit, so missions created there use the same engine, approval gates and audit log as the dashboard.

## Register the MCP server

Start Orbit first (`orbit start`), then:

```bash
# with a global `orbit` command (cd packages/cli && npm link)
claude mcp add -s user orbit -- orbit mcp

# or straight from a checkout
claude mcp add -s user orbit -- node /absolute/path/to/orbit/packages/cli/dist/orbit.js mcp
```

`-s user` makes Orbit available in every project. The bridge finds the running server through `ORBIT_HOME/server.json` and authenticates with the local token in `ORBIT_HOME/auth.json`. If you use a custom `ORBIT_HOME`, pass it: `claude mcp add -s user orbit -e ORBIT_HOME=/path -- orbit mcp`.

## Tools

| Tool | What it does |
|---|---|
| `orbit_list_projects` | Connected repositories and the Asana projects mapped to them |
| `orbit_list_asana_tasks` | Open tasks per connected project, with any mission already attached |
| `orbit_create_mission` | Run with Orbit: from an Asana task gid, or a title, description and repositories |
| `orbit_analyze_task` | The plan: repositories with evidence, likely files, risks, criteria, questions |
| `orbit_get_mission_status` | One mission in detail, or recent missions |
| `orbit_list_approvals` | Everything waiting for a human decision |
| `orbit_approve_scope` | Approve the planned repositories (only when you say so) |
| `orbit_review_changes` | The real diff, Orbit-run check results and reviewer findings |

Publishing a pull request is deliberately not an MCP tool: approve it in the dashboard or with `orbit publish`.

## Things to ask

- "Orbit, check my Asana project and show which tasks can be implemented."
- "Create a mission for Asana task 1209876543210 and show me the proposed repository changes."
- "What is waiting for my approval in Orbit?"
- "Show me the diff and test results for msn_7f3k2p9a."

## The skill

`skills/orbit/SKILL.md` teaches Claude Code how to use these tools well. Install it for your user:

```bash
mkdir -p ~/.claude/skills
cp -r skills/orbit ~/.claude/skills/orbit
```

On Windows (PowerShell): `Copy-Item -Recurse skills\orbit $HOME\.claude\skills\orbit`.

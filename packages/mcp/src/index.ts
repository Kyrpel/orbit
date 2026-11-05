import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OrbitClient, OrbitClientError } from '@orbit/client';
import { MISSION_STATE_META, ORBIT_VERSION, formatUsd, type MissionDetailDTO, type MissionSummaryDTO } from '@orbit/shared';

/**
 * Orbit's MCP server for Claude Code and other MCP clients. It is a thin
 * bridge: every tool calls the local Orbit API, so missions created here go
 * through exactly the same engine, approval gates and audit log as the
 * dashboard and CLI.
 */

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

function line(m: MissionSummaryDTO): string {
  const meta = MISSION_STATE_META[m.status];
  const repos = m.repos.map((r) => `${r.name}${r.prUrl ? ` (PR ${r.prUrl})` : ''}`).join(', ') || 'no repo yet';
  return `- ${m.id} · ${meta.label} · ${m.title} · ${repos}${m.blockedReason ? ` · blocked: ${m.blockedReason}` : ''}`;
}

function describeMission(d: MissionDetailDTO, dashboard: string): string {
  const meta = MISSION_STATE_META[d.status];
  const out = [`Mission ${d.id}: ${d.title}`, `Status: ${meta.label} — ${meta.description}`, `Dashboard: ${dashboard}/missions/${d.id}`];
  if (d.plan) {
    out.push('', `Plan: ${d.plan.summary}`);
    if (d.plan.steps.length) out.push(...d.plan.steps.map((s, i) => `  ${i + 1}. ${s}`));
    if (d.plan.acceptanceCriteria.length) out.push('Acceptance criteria:', ...d.plan.acceptanceCriteria.map((c) => `  - ${c}`));
    if (d.plan.questions.length) out.push('Open questions:', ...d.plan.questions.map((q) => `  - ${q}`));
  }
  for (const mr of d.missionRepos.filter((r) => r.status !== 'excluded')) {
    out.push('', `Repository ${mr.repoName} [${mr.status}]`);
    if (mr.selection) {
      out.push(`  Why: ${mr.selection.reason}`);
      for (const e of mr.selection.evidence.slice(0, 5)) out.push(`  Evidence: ${e}`);
      if (mr.selection.likelyFiles.length) out.push(`  Likely files: ${mr.selection.likelyFiles.slice(0, 10).join(', ')}`);
      if (mr.selection.uncertainty) out.push(`  Uncertainty: ${mr.selection.uncertainty}`);
    }
    if (mr.branch) out.push(`  Branch: ${mr.branch}`);
    if (mr.diffStats) out.push(`  Diff: ${mr.diffStats.files} files, +${mr.diffStats.additions} −${mr.diffStats.deletions}`);
    if (mr.pr) out.push(`  Pull request: ${mr.pr.url}`);
    if (mr.lastError) out.push(`  Last error: ${mr.lastError}`);
  }
  const latest = d.verifications.filter((v) => v.kind === 'verify').reduce((m, v) => Math.max(m, v.iteration), -1);
  const checks = d.verifications.filter((v) => v.kind === 'verify' && v.iteration === latest);
  if (checks.length) out.push('', 'Checks (run by Orbit):', ...checks.map((c) => `  - ${c.label} \`${c.command}\`: ${c.status}`));
  const review = d.reviews[d.reviews.length - 1];
  if (review) out.push('', `Review: ${review.verdict} — ${review.summary}`, ...review.findings.slice(0, 10).map((f) => `  - [${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ''}`));
  out.push('', `Allowed next actions: ${d.allowedActions.join(', ') || 'none'}`, `Cost so far: ${formatUsd(d.costUsd)}`);
  return out.join('\n');
}

export function createOrbitMcpServer(getClient: () => OrbitClient = () => OrbitClient.fromEnvironment('mcp')): McpServer {
  const server = new McpServer({ name: 'orbit', version: ORBIT_VERSION });

  const run = async (fn: (c: OrbitClient) => Promise<string>): Promise<ToolResult> => {
    try {
      return text(await fn(getClient()));
    } catch (err) {
      const msg = err instanceof OrbitClientError ? `${err.message}${err.hint ? `\nHint: ${err.hint}` : ''}` : (err as Error).message;
      return { content: [{ type: 'text', text: `Orbit error: ${msg}` }], isError: true };
    }
  };

  server.registerTool(
    'orbit_list_projects',
    { title: 'List Orbit projects', description: 'List repositories connected to Orbit and the Asana projects mapped to them.', inputSchema: {} },
    async () =>
      run(async (c) => {
        const [repos, projects] = await Promise.all([c.repos(), c.projects()]);
        const repoLines = repos.map((r) => `- ${r.name} (${r.id}) ${r.allowModify ? '' : '[read-only for Orbit] '}${r.localPath}${r.github ? ` · github ${r.github.owner}/${r.github.repo}` : ''}`);
        const projectLines = projects.map((p) => `- ${p.name} (${p.id}) → ${p.repoIds.map((id) => repos.find((r) => r.id === id)?.name ?? id).join(', ') || 'no repos mapped'}${p.triggersEnabled ? ' · /orbit run enabled' : ''}`);
        return `Repositories (${repos.length}):\n${repoLines.join('\n') || '- none'}\n\nConnected projects (${projects.length}):\n${projectLines.join('\n') || '- none'}`;
      }),
  );

  server.registerTool(
    'orbit_list_asana_tasks',
    {
      title: 'List Asana tasks',
      description: 'List open tasks in a connected Asana project, with any Orbit mission already attached. Use this to find tasks that can be implemented.',
      inputSchema: { projectId: z.string().optional().describe('Orbit project id (from orbit_list_projects). Omit to list every connected project.') },
    },
    async ({ projectId }) =>
      run(async (c) => {
        const projects = projectId ? (await c.projects()).filter((p) => p.id === projectId) : await c.projects();
        if (projects.length === 0) return 'No connected Asana projects. Connect one in the Orbit dashboard → Projects.';
        const parts: string[] = [];
        for (const p of projects) {
          const tasks = await c.projectTasks(p.id);
          parts.push(
            `## ${p.name} (${p.id})`,
            ...tasks.slice(0, 50).map((t) => `- ${t.id} · ${t.title}${t.mission ? ` · mission ${t.mission.id} (${MISSION_STATE_META[t.mission.status].label})` : ' · ready'}${p.repoIds.length ? '' : ' · (no repository mapped)'}`),
          );
        }
        return parts.join('\n');
      }),
  );

  server.registerTool(
    'orbit_create_mission',
    {
      title: 'Run with Orbit',
      description:
        'Create a mission: Orbit plans the work, picks authorized repositories, implements in an isolated worktree, runs checks and asks for human approval before anything is pushed. Provide either an Asana task (integrationId + taskId) or a title/description with repository ids.',
      inputSchema: {
        title: z.string().optional(),
        description: z.string().optional(),
        repoIds: z.array(z.string()).optional().describe('Repository ids (from orbit_list_projects) for a local mission.'),
        asanaTaskId: z.string().optional().describe('Asana task gid to run.'),
        projectId: z.string().optional().describe('Orbit project id the Asana task belongs to.'),
        extraInstructions: z.string().optional(),
      },
    },
    async (args) =>
      run(async (c) => {
        let source: { integrationId: string; taskId: string; projectId?: string | null } | undefined;
        if (args.asanaTaskId) {
          const projects = await c.projects();
          const project = args.projectId ? projects.find((p) => p.id === args.projectId) : projects[0];
          const integrationId = project?.integrationId ?? (await c.integrations()).find((i) => i.provider === 'asana')?.id;
          if (!integrationId) return 'Asana is not connected. Connect it in the Orbit dashboard first.';
          source = { integrationId, taskId: args.asanaTaskId, projectId: project?.id ?? null };
        }
        const r = await c.createMission({
          ...(args.title ? { title: args.title } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.repoIds ? { repoIds: args.repoIds } : {}),
          ...(source ? { source } : {}),
          extraInstructions: args.extraInstructions ?? null,
        });
        return `${r.created ? 'Created' : 'Reused active'} mission ${r.mission.id} (${MISSION_STATE_META[r.mission.status].label}).\nOrbit is analyzing it now. Check progress with orbit_get_mission_status, or open ${c.baseUrl}/missions/${r.mission.id}`;
      }),
  );

  server.registerTool(
    'orbit_analyze_task',
    {
      title: 'Analyze a task',
      description: 'Show the plan Orbit proposes for a mission: chosen repositories with evidence, likely files, risks, acceptance criteria and open questions.',
      inputSchema: { missionId: z.string() },
    },
    async ({ missionId }) => run(async (c) => describeMission(await c.mission(missionId), c.baseUrl)),
  );

  server.registerTool(
    'orbit_get_mission_status',
    {
      title: 'Mission status',
      description: 'Current status of one mission (with checks, review and PR links), or a list of recent missions when no id is given.',
      inputSchema: { missionId: z.string().optional() },
    },
    async ({ missionId }) =>
      run(async (c) => {
        if (missionId) return describeMission(await c.mission(missionId), c.baseUrl);
        const list = await c.missions({ limit: 20 });
        return list.length ? list.map(line).join('\n') : 'No missions yet.';
      }),
  );

  server.registerTool(
    'orbit_list_approvals',
    { title: 'Approval inbox', description: 'Missions waiting for a human decision: scope approval, change review, PR approval, or blocked.', inputSchema: {} },
    async () =>
      run(async (c) => {
        const list = await c.approvals();
        return list.length ? list.map(line).join('\n') : 'Nothing is waiting for you.';
      }),
  );

  server.registerTool(
    'orbit_approve_scope',
    {
      title: 'Approve mission scope',
      description: 'Approve the planned repositories for a mission so implementation can start. Only do this when the user explicitly approves.',
      inputSchema: { missionId: z.string(), repoIds: z.array(z.string()).optional().describe('Override which repositories are in scope.'), notes: z.string().optional() },
    },
    async ({ missionId, repoIds, notes }) =>
      run(async (c) => {
        const m = await c.approveScope(missionId, { ...(repoIds ? { repoIds } : {}), notes: notes ?? null });
        return `Scope approved. Mission ${m.id} is ${MISSION_STATE_META[m.status].label}.`;
      }),
  );

  server.registerTool(
    'orbit_review_changes',
    {
      title: 'Review mission changes',
      description: 'Show the actual git diff, Orbit-run check results and reviewer findings for a mission that is ready for review. Read-only.',
      inputSchema: { missionId: z.string(), maxChars: z.number().int().min(1000).max(200_000).optional() },
    },
    async ({ missionId, maxChars }) =>
      run(async (c) => {
        const d = await c.mission(missionId);
        const parts = [describeMission(d, c.baseUrl)];
        for (const mr of d.missionRepos.filter((r) => r.baseSha)) {
          const diff = await c.diff(missionId, mr.id);
          const limit = maxChars ?? 40_000;
          parts.push('', `### Diff for ${mr.repoName}${diff.truncated || diff.diff.length > limit ? ' (truncated)' : ''}`, '```diff', diff.diff.slice(0, limit), '```');
        }
        parts.push('', 'To approve, request changes or publish, use the Orbit dashboard (publishing always needs explicit approval).');
        return parts.join('\n');
      }),
  );

  return server;
}

export async function runMcpStdio(): Promise<void> {
  const server = createOrbitMcpServer();
  await server.connect(new StdioServerTransport());
}

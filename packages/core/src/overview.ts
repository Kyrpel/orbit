import { and, desc, eq, gte, inArray, isNotNull, agentRuns, auditLog, externalProjects, missionEvents, missionRepos, missions, repos } from '@orbit/database';
import type { AgentRoleDTO, ActivityItem, OverviewDTO, TeamSeat } from '@orbit/shared';
import type { OrbitContext } from './context';
import { planSeat, seatResolution } from './team';
import type { IntegrationService } from './integrations';
import type { MissionService } from './missions';

const ROLES: { role: TeamSeat; title: string; description: string }[] = [
  { role: 'planner', title: 'Planner', description: 'Reads the task and your code, picks the right projects with evidence, and writes the plan and acceptance criteria.' },
  { role: 'engineer', title: 'Engineer', description: 'Builds the approved plan in an isolated copy of your project and adds tests. Never commits or pushes.' },
  { role: 'reviewer', title: 'Reviewer', description: 'Reads the real diff against the plan, using the check results Orbit ran itself. Works best as a different AI from the engineer.' },
  { role: 'security', title: 'Security reviewer', description: 'Checks every Autopilot change, and your workspace changes when you click Check security, for leaked secrets, injection, missing auth checks and risky dependencies.' },
  { role: 'prompter', title: 'Prompt engineer', description: 'Rewrites rough tasks into clear ones with acceptance criteria: your Asana tasks (Improve, then update in Asana) and your requests in the workspace (Improve).' },
  { role: 'assistant', title: 'Session agent', description: 'Works with you in a project when you open it in the workspace, like Claude Code in a terminal: it edits the files directly and asks before running commands. Each session tab can also pick its own AI.' },
];

export class OverviewService {
  constructor(
    private readonly ctx: OrbitContext,
    private readonly missionService: MissionService,
    private readonly integrationService: IntegrationService,
  ) {}

  async overview(): Promise<OverviewDTO> {
    const db = this.ctx.db;
    const weekAgo = new Date(this.ctx.now().getTime() - 7 * 86400_000).toISOString();
    const attention = this.missionService.list({ attention: true, limit: 20 });
    const active = this.missionService.list({ active: true, limit: 20 });
    const recent = this.missionService.list({ status: ['COMPLETED', 'PR_CREATED', 'CANCELLED'], limit: 8 });
    const completed7d = db.select({ id: missions.id }).from(missions).where(and(inArray(missions.status, ['COMPLETED', 'PR_CREATED']), gte(missions.updatedAt, weekAgo))).all().length;
    const prsOpened = db.select({ id: missionRepos.id }).from(missionRepos).where(isNotNull(missionRepos.prUrl)).all().length;

    const running = db
      .select({ run: agentRuns, title: missions.title })
      .from(agentRuns)
      .innerJoin(missions, eq(missions.id, agentRuns.missionId))
      .where(eq(agentRuns.status, 'running'))
      .all();
    const runningAgents = running.map(({ run, title }) => {
      const last = db.select().from(missionEvents).where(eq(missionEvents.missionId, run.missionId)).orderBy(desc(missionEvents.id)).limit(1).get();
      return { runId: run.id, missionId: run.missionId, missionTitle: title, role: run.role, startedAt: run.startedAt, lastEvent: last?.title ?? null };
    });

    // Suggestions: open tasks from connected projects that have never been run. Best effort, bounded.
    const suggestions: OverviewDTO['suggestions'] = [];
    const projects = db.select().from(externalProjects).limit(3).all();
    for (const p of projects) {
      try {
        const tasks = await this.integrationService.listProjectTasks(p.id);
        for (const t of tasks.filter((x) => !x.mission && !x.completed).slice(0, 4)) suggestions.push({ ...t, projectName: p.name });
      } catch {
        /* suggestions are optional */
      }
      if (suggestions.length >= 6) break;
    }

    const repoCount = db.select({ id: repos.id }).from(repos).all().length;
    const settings = this.ctx.settings.get();
    const runtimeReady = !!(await planSeat(this.ctx, 'engineer').catch(() => null))?.primary?.availability.available;
    return {
      counts: {
        repos: repoCount,
        projects: db.select({ id: externalProjects.id }).from(externalProjects).all().length,
        activeMissions: active.length,
        attention: attention.length,
        completed7d,
        prsOpened,
      },
      attention,
      active,
      recent,
      runningAgents,
      suggestions,
      setup: {
        hasRepos: repoCount > 0,
        hasAsana: this.integrationService.list().length > 0,
        runtimeReady,
        firstMissionDone: db.select({ id: missions.id }).from(missions).where(inArray(missions.status, ['AWAITING_REVIEW', 'AWAITING_PR_APPROVAL', 'PR_CREATED', 'COMPLETED'])).limit(1).all().length > 0,
        onboardingComplete: !!settings.onboarding.completedAt,
      },
    };
  }

  async agents(): Promise<AgentRoleDTO[]> {
    const settings = this.ctx.settings.get();
    const runs = this.ctx.db
      .select({ run: agentRuns, title: missions.title })
      .from(agentRuns)
      .innerJoin(missions, eq(missions.id, agentRuns.missionId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(600)
      .all();
    const plans = await Promise.all(ROLES.map((r) => planSeat(this.ctx, r.role)));
    return ROLES.map((r, i) => {
      const mine = runs.filter((x) => x.run.role === r.role);
      const finished = mine.filter((x) => x.run.durationMs != null);
      return {
        role: r.role,
        title: r.title,
        description: r.description,
        model: settings.models[r.role],
        codexModel: settings.codexModels[r.role],
        effort: settings.efforts[r.role],
        runtime: settings.execution.runtime,
        provider: settings.team[r.role],
        resolved: seatResolution(plans[i]!),
        stats: {
          runs: mine.length,
          succeeded: mine.filter((x) => x.run.status === 'succeeded').length,
          failed: mine.filter((x) => ['failed', 'timeout'].includes(x.run.status)).length,
          avgDurationMs: finished.length ? Math.round(finished.reduce((a, x) => a + (x.run.durationMs ?? 0), 0) / finished.length) : null,
          totalCostUsd: mine.reduce((a, x) => a + (x.run.costUsd ?? 0), 0),
        },
        recentRuns: mine.slice(0, 8).map(({ run, title }) => ({
          id: run.id,
          missionId: run.missionId,
          missionRepoId: run.missionRepoId,
          role: run.role,
          runtime: run.runtime,
          model: run.model,
          iteration: run.iteration,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          durationMs: run.durationMs,
          costUsd: run.costUsd,
          numTurns: run.numTurns,
          summary: run.summary,
          error: run.error,
          missionTitle: title,
        })),
      };
    });
  }

  activity(limit = 100): ActivityItem[] {
    return this.ctx.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(Math.min(limit, 500))
      .all()
      .map((a) => ({ id: a.id, ts: a.ts, actor: a.actor, action: a.action, target: a.target, summary: a.summary }));
  }
}

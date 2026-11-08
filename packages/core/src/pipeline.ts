import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  ENGINEER_SYSTEM,
  EngineerOutput,
  engineerOutputSchema,
  engineerPrompt,
  PLANNER_SYSTEM,
  PlannerOutput,
  plannerOutputSchema,
  plannerPrompt,
  REVIEWER_SYSTEM,
  SECURITY_SYSTEM,
  SecurityOutput,
  securityOutputSchema,
  securityPrompt,
  ReviewerOutput,
  reviewerOutputSchema,
  reviewerPrompt,
  type AgentRunRequest,
  type AgentRunResult,
  type EngineerFeedback,
  type ReferenceBrief,
  type RepoBrief,
  type RequirementInput,
} from '@orbit/agents';
import { and, desc, eq, agentRuns, approvals, missionRepos, missions as missionsTable, projectRepos, reviews, verifications, type JobRow, type MissionRepoRow, type MissionRow, type RepoRow, type VerificationRow } from '@orbit/database';
import {
  errorMessage,
  formatDuration,
  formatUsd,
  newId,
  parseCommandLine,
  redactSecrets,
  shortId,
  slugify,
  tail,
  truncate,
  type AgentRole,
  type BlockedCode,
  type CommandEventData,
  type CommandSpec,
  type MissionPlan,
  type RepoSelection,
  type ReviewFinding,
} from '@orbit/shared';
import { snapshotFolder } from '@orbit/git';
import { audit, nowIso, recordMissionEvent, type OrbitContext } from './context';
import { agentEventRecord } from './agent-events';
import { forgetResolvedRuntime } from './runtimes';
import { forgetCodexAvailability, planSeat, worktreeRoot, type SeatCandidate, type SeatPlan } from './team';
import type { MissionService } from './missions';
import type { Notifier } from './notifier';
import type { Outbox } from './outbox';
import { scanForSecrets } from './pr';
import { RetryableJobError, type JobContext, type JobQueue } from './queue';
import type { RepoService } from './repos';
import { heuristicSelection, scoreRepositories, suggestReferences } from './router';

const ROLE_TITLE: Record<AgentRole, string> = { planner: 'Planner', engineer: 'Engineer', reviewer: 'Reviewer', security: 'Security reviewer' };

interface AgentStep {
  mission: MissionRow;
  missionRepoId: string | null;
  role: AgentRole;
  request: Omit<AgentRunRequest, 'execution' | 'maxBudgetUsd' | 'model' | 'effort' | 'role'>;
  jctx: JobContext;
}

/** Thrown inside the pipeline to move a mission to BLOCKED with a human-readable reason. */
class BlockedError extends Error {
  constructor(
    message: string,
    readonly code: BlockedCode | null = null,
  ) {
    super(message);
  }
}

const VERIFY_ENV_DENYLIST = /^(ANTHROPIC_|CLAUDE_CODE_|GH_TOKEN$|GITHUB_TOKEN$|GH_ENTERPRISE_TOKEN$|ORBIT_|ASANA_|NPM_TOKEN$|NODE_AUTH_TOKEN$)/;

function verificationEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (typeof v === 'string' && !VERIFY_ENV_DENYLIST.test(k)) env[k] = v;
  env.CI = '1';
  env.FORCE_COLOR = '0';
  return env;
}

export class Pipeline {
  constructor(
    private readonly ctx: OrbitContext,
    private readonly missions: MissionService,
    private readonly repoService: RepoService,
    private readonly notifier: Notifier,
    private readonly outbox: Outbox,
    private readonly queue: JobQueue,
  ) {}

  /** The seat's AI plan, or a block with the reason no AI can take the seat. */
  async readySeat(seat: AgentRole): Promise<SeatPlan & { primary: SeatCandidate }> {
    const plan = await planSeat(this.ctx, seat);
    if (!plan.primary) throw new BlockedError(`No AI is connected for the ${seat}. Sign in to Claude Code (run \`claude\`) or Codex (run \`codex login\`).`, 'runtime_unavailable');
    if (!plan.primary.availability.available) {
      forgetResolvedRuntime(this.ctx);
      forgetCodexAvailability(this.ctx);
      throw new BlockedError(`${plan.primary.runtime.displayName} is not ready: ${plan.primary.availability.reason ?? 'unavailable'}`, 'runtime_unavailable');
    }
    return plan as SeatPlan & { primary: SeatCandidate };
  }

  private requirement(m: MissionRow): RequirementInput {
    const rev = this.missions.currentRevision(m);
    return { title: rev.title, body: rev.body, comments: rev.comments, extraInstructions: rev.extraInstructions, sourceUrl: m.sourceUrl };
  }

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  private async runAgent(o: AgentStep): Promise<{ result: AgentRunResult; runId: string }> {
    const plan = await this.readySeat(o.role);
    const first = await this.runAgentWith(o, plan.primary);
    if (first.result.status !== 'rate_limited' || !plan.fallback) return first;
    // The orchestrator's hand-off: the same step, on the other AI.
    recordMissionEvent(this.ctx, o.mission.id, {
      kind: 'note',
      actor: 'system',
      title: `${plan.primary.label} hit its usage limit. Switching the ${o.role} to ${plan.fallback.label}.`,
      detail: first.result.error,
      missionRepoId: o.missionRepoId,
    });
    return this.runAgentWith(o, plan.fallback);
  }

  private async runAgentWith(o: AgentStep, seat: SeatCandidate): Promise<{ result: AgentRunResult; runId: string }> {
    const settings = this.ctx.settings.get();
    const runtime = seat.runtime;
    const runId = newId('run');
    const { model, effort } = seat;
    const started = nowIso(this.ctx);
    this.ctx.db
      .insert(agentRuns)
      .values({ id: runId, missionId: o.mission.id, missionRepoId: o.missionRepoId, role: o.role, runtime: runtime.id, model, iteration: o.mission.iteration, status: 'running', startedAt: started })
      .run();
    const who = runtime.kind === 'scripted' ? ' (scripted runtime, no AI)' : ` (${seat.label}${model ? ` · ${model}` : ''}, ${effort ?? 'default'} effort)`;
    recordMissionEvent(this.ctx, o.mission.id, {
      kind: 'agent',
      actor: o.role,
      title: `${ROLE_TITLE[o.role]} started${who}`,
      data: { runId, phase: 'start', runtime: runtime.id, provider: seat.provider, model, effort },
      missionRepoId: o.missionRepoId,
    });

    const request: AgentRunRequest = {
      ...o.request,
      role: o.role,
      model,
      effort,
      maxBudgetUsd: settings.execution.maxBudgetUsdPerRun,
      execution: {
        // Read-only roles have no command tools, so they never need the OS sandbox.
        mode: o.role === 'engineer' ? settings.execution.mode : 'trusted-local',
        allowNetworkTools: settings.execution.allowAgentNetwork,
      },
    };

    const result = await runtime.run(request, {
      signal: o.jctx.signal,
      onEvent: (e) => {
        o.jctx.heartbeat();
        if (e.type === 'tool_result' && !e.isError) return;
        if (e.type === 'text') this.ctx.bus.publish({ type: 'agent.output', missionId: o.mission.id, runId, role: o.role, text: e.text });
        recordMissionEvent(this.ctx, o.mission.id, { ...agentEventRecord(e, runId), actor: o.role, missionRepoId: o.missionRepoId });
      },
    });
    if (result.status === 'rate_limited' || result.status === 'failed') {
      forgetResolvedRuntime(this.ctx);
      forgetCodexAvailability(this.ctx);
    }

    const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : result.status === 'timeout' ? 'timeout' : 'failed';
    this.ctx.db
      .update(agentRuns)
      .set({
        status,
        finishedAt: nowIso(this.ctx),
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        usage: result.usage,
        numTurns: result.numTurns,
        sessionId: result.sessionId,
        model: result.model ?? model,
        summary: result.text ? truncate(redactSecrets(result.text), 4000) : null,
        error: result.error ? truncate(redactSecrets(result.error), 4000) : null,
      })
      .where(eq(agentRuns.id, runId))
      .run();
    this.missions.addCost(o.mission.id, result.costUsd);
    recordMissionEvent(this.ctx, o.mission.id, {
      kind: status === 'succeeded' ? 'agent' : 'error',
      actor: o.role,
      title: `${ROLE_TITLE[o.role]} ${status === 'succeeded' ? 'finished' : status === 'cancelled' ? 'was cancelled' : `stopped (${result.status.replace('_', ' ')})`} after ${formatDuration(result.durationMs)}${
        result.costUsd ? (runtime.id === 'claude-code-cli' ? ` · plan usage ≈ ${formatUsd(result.costUsd)} at API prices` : ` · ${formatUsd(result.costUsd)}`) : ''
      }`,
      detail: result.error,
      data: { runId, phase: 'end', status, numTurns: result.numTurns, deniedTools: result.deniedTools.length },
      missionRepoId: o.missionRepoId,
    });
    return { result, runId };
  }

  /** Converts a failed agent result into the right mission outcome (always throws). */
  private handleAgentFailure(job: JobRow, m: MissionRow, role: AgentRole, result: AgentRunResult): never {
    const settings = this.ctx.settings.get();
    if (result.status === 'cancelled') throw new BlockedError('__cancelled__');
    if (result.status === 'timeout') throw new BlockedError(`The ${role} timed out after ${settings.execution.agentTimeoutMinutes} minutes.`);
    if (result.status === 'budget_exceeded') throw new BlockedError(`The ${role} reached the per-run budget limit (${formatUsd(settings.execution.maxBudgetUsdPerRun)}). Raise it in Settings or narrow the task.`);
    if (result.status === 'max_turns') throw new BlockedError(`The ${role} reached the turn limit (${settings.execution.maxTurns}). Narrow the task or raise the limit in Settings.`);
    if (result.status === 'refused') throw new BlockedError(`The model declined to work on this task: ${result.error ?? ''}`);
    if (result.status === 'rate_limited') {
      throw new BlockedError(
        `The ${role}'s AI hit its usage limit${result.error ? ` (${truncate(result.error, 200)})` : ''}. Retry when it resets, or connect a second AI on the Agents page so Orbit can switch automatically.`,
        'runtime_unavailable',
      );
    }
    const err = result.error ?? 'unknown error';
    if (/sandbox/i.test(err)) {
      throw new BlockedError(
        `The agent sandbox could not start on this machine (${truncate(err, 200)}). Run agents in trusted-local mode (requires your consent) or run Orbit on macOS/Linux.`,
        'sandbox_unavailable',
      );
    }
    if (job.attempts < job.maxAttempts) {
      recordMissionEvent(this.ctx, m.id, { kind: 'error', actor: role, title: `${ROLE_TITLE[role]} crashed, retrying (attempt ${job.attempts + 1} of ${job.maxAttempts})`, detail: err });
      throw new RetryableJobError(err, 15_000);
    }
    throw new Error(`The ${role} failed: ${err}`);
  }

  /** Wraps a stage: BlockedError → BLOCKED, unexpected errors on the last attempt → FAILED. */
  private async guard(job: JobRow, fn: (m: MissionRow) => Promise<void>): Promise<void> {
    const id = job.missionId;
    if (!id) return;
    try {
      await fn(this.missions.row(id));
    } catch (err) {
      const current = this.missions.row(id);
      if (current.status === 'CANCELLED') {
        await this.missions.cleanupWorktrees(id);
        return;
      }
      if (err instanceof BlockedError) {
        if (err.message === '__cancelled__') return;
        if (!['BLOCKED', 'FAILED', 'COMPLETED', 'CANCELLED'].includes(current.status)) this.missions.block(id, err.message, undefined, err.code);
        return;
      }
      if (err instanceof RetryableJobError) throw err;
      if (!['BLOCKED', 'FAILED', 'COMPLETED', 'CANCELLED'].includes(current.status)) this.missions.fail(id, errorMessage(err));
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 1: analyze
  // ---------------------------------------------------------------------------

  analyze = async (job: JobRow, jctx: JobContext): Promise<void> => {
    await this.guard(job, async (start) => {
      let m = start;
      if (m.status === 'DRAFT') m = this.missions.transition(m.id, 'ANALYZING', { title: 'Analyzing the task' });
      if (m.status !== 'ANALYZING') return;
      const settings = this.ctx.settings.get();

      let candidateIds: string[] = m.requestedRepoIds ?? [];
      if (candidateIds.length === 0 && m.sourceProjectId) {
        candidateIds = this.ctx.db.select().from(projectRepos).where(eq(projectRepos.projectId, m.sourceProjectId)).all().map((r) => r.repoId);
      }
      let candidates = this.repoService.rowsByIds(candidateIds).filter((r) => r.allowModify);
      if (candidates.length === 0) {
        throw new BlockedError(
          m.sourceProjectId
            ? 'No repository Orbit may modify is mapped to this project. Map one in Projects, then retry.'
            : m.sourceProvider === 'local'
              ? 'The selected repositories are no longer available.'
              : "This task's project is not connected to Orbit. Connect it in Projects and map a repository, then retry.",
        );
      }
      for (const c of candidates) await this.repoService.refreshSummary(c.id).catch(() => undefined);
      candidates = this.repoService.rowsByIds(candidates.map((c) => c.id));

      const req = this.requirement(m);
      const ranked = scoreRepositories({ title: req.title, body: req.body, extra: req.extraInstructions }, candidates);
      const runtime = (await this.readySeat('planner')).primary.runtime;
      this.ctx.db.update(missionsTable).set({ runtime: runtime.id }).where(eq(missionsTable.id, m.id)).run();
      m = this.missions.row(m.id);

      const briefs: RepoBrief[] = candidates.map((r) => {
        const ev = ranked.find((x) => x.repoId === r.id);
        return {
          key: r.name,
          name: r.name,
          ...(r.summary?.description ? { description: r.summary.description } : {}),
          languages: r.summary?.languages ?? [],
          frameworks: r.summary?.frameworks ?? [],
          topLevel: r.summary?.topLevel ?? [],
          ...(r.summary?.instructionsExcerpt ? { instructionsExcerpt: r.summary.instructionsExcerpt } : {}),
          ...(r.summary?.readmeExcerpt ? { readmeExcerpt: r.summary.readmeExcerpt } : {}),
          heuristicEvidence: ev?.evidence ?? [],
          readPath: r.localPath,
        };
      });
      const notes: string[] = [];
      if (!m.triggerVerified) notes.push('The person who triggered this mission could not be verified. A human will confirm the scope.');
      if (candidates.length === 1) notes.push('Only one repository is authorized for this mission.');

      // Reference projects: approved for reading. The planner has no write tools, so it reads them in place.
      const references = this.repoService.rowsByIds(m.referenceRepoIds ?? []).filter((r) => existsSync(r.localPath));
      const referenceSuggestions = suggestReferences(
        `${req.title}\n${req.body}\n${req.extraInstructions ?? ''}\n${req.comments.map((c) => c.text).join('\n')}`,
        this.repoService.rowsByIds(this.allRepoIds()),
        new Set([...candidates.map((c) => c.id), ...references.map((r) => r.id)]),
      );

      const first = candidates[0] as RepoRow;
      const { result, runId } = await this.runAgent({
        mission: m,
        missionRepoId: null,
        role: 'planner',
        jctx,
        request: {
          prompt: plannerPrompt(
            req,
            briefs,
            notes,
            references.map((r) => ({ name: r.name, path: r.localPath, ...(r.summary?.description ? { description: r.summary.description } : {}) })),
          ),
          systemAppend: PLANNER_SYSTEM,
          cwd: first.localPath,
          readRoots: [...candidates.slice(1).map((c) => c.localPath), ...references.map((r) => r.localPath)],
          access: 'read-only',
          maxTurns: Math.min(settings.execution.maxTurns, 40),
          timeoutMs: Math.min(settings.execution.agentTimeoutMinutes, 15) * 60_000,
          outputSchema: plannerOutputSchema as unknown as Record<string, unknown>,
        },
      });
      if (result.status !== 'succeeded') this.handleAgentFailure(job, m, 'planner', result);
      const parsed = PlannerOutput.safeParse(result.structured);
      if (!parsed.success) throw new BlockedError('The planner did not return a valid plan. Retry, or try a more capable model in Settings.');

      const byKey = new Map(candidates.map((c) => [c.name.toLowerCase(), c]));
      const selections: RepoSelection[] = [];
      const dropped: MissionPlan['droppedRepositories'] = [];
      for (const r of parsed.data.repositories) {
        const repo = byKey.get(r.repoKey.trim().toLowerCase());
        if (!repo) {
          dropped.push({ name: truncate(r.repoKey, 80), reason: 'Not an authorized repository for this mission. Ignored.' });
          continue;
        }
        if (selections.some((s) => s.repoId === repo.id)) continue;
        selections.push({
          repoId: repo.id,
          repoName: repo.name,
          source: 'planner',
          reason: r.reason,
          evidence: r.evidence.slice(0, 12),
          likelyFiles: r.likelyFiles.slice(0, 30),
          changeSummary: r.changeSummary,
          risks: r.risks.slice(0, 10),
          uncertainty: r.uncertainty,
        });
      }
      const routingNotes: string[] = [];
      if (selections.length === 0 && candidates.length === 1) {
        selections.push({
          repoId: first.id,
          repoName: first.name,
          source: 'mapping',
          reason: 'The only repository mapped to this task.',
          evidence: ranked[0]?.evidence ?? [],
          likelyFiles: [],
          changeSummary: '',
          risks: [],
          uncertainty: 'The planner did not name a repository; Orbit used the only authorized one.',
        });
        routingNotes.push('Planner did not choose a repository; using the only mapped one.');
      }
      if (selections.length === 0) {
        const h = heuristicSelection(ranked);
        routingNotes.push(`Planner could not decide. Keyword routing: ${h.note}`);
      }
      if (dropped.length) routingNotes.push(`${dropped.length} unauthorized repository suggestion(s) were ignored.`);

      const plan: MissionPlan = {
        summary: parsed.data.summary,
        steps: parsed.data.steps.slice(0, 20),
        acceptanceCriteria: parsed.data.acceptanceCriteria.slice(0, 20),
        repositories: selections,
        questions: parsed.data.questions.slice(0, 10),
        routingNotes,
        ambiguous: parsed.data.needsHumanDecision || selections.length === 0,
        generatedBy: 'planner',
        agentRunId: runId,
        droppedRepositories: dropped,
        referenceSuggestions,
      };

      const ts = nowIso(this.ctx);
      const existing = this.missions.missionRepoRows(m.id);
      for (const c of candidates) {
        const sel = selections.find((s) => s.repoId === c.id);
        const ev = ranked.find((x) => x.repoId === c.id);
        const selection: RepoSelection = sel ?? {
          repoId: c.id,
          repoName: c.name,
          source: 'router',
          reason: 'Authorized for this mission but not chosen by the planner.',
          evidence: ev?.evidence ?? [],
          likelyFiles: [],
          changeSummary: '',
          risks: [],
          uncertainty: '',
        };
        const status = sel ? 'selected' : 'excluded';
        const row = existing.find((e) => e.repoId === c.id);
        if (row) this.missions.updateMissionRepo(row.id, { status: row.branch && sel ? 'in_progress' : status, selection });
        else this.ctx.db.insert(missionRepos).values({ id: newId('mr'), missionId: m.id, repoId: c.id, status, selection, createdAt: ts, updatedAt: ts }).run();
      }

      const reasons: string[] = [];
      if (settings.approvals.scope === 'always') reasons.push('Settings require scope approval for every mission.');
      if (plan.ambiguous) reasons.push('The repository choice is ambiguous.');
      if (selections.length > 1) reasons.push(`The plan changes ${selections.length} repositories.`);
      if (!m.triggerVerified) reasons.push('The trigger author could not be verified.');
      if (plan.questions.length) reasons.push('The planner has open questions.');
      if (referenceSuggestions.length) reasons.push(`The task mentions ${referenceSuggestions.map((s) => s.repoName).join(', ')}; confirm whether the engineer may read it.`);

      m = this.missions.row(m.id);
      const repoLine = selections.map((s) => s.repoName).join(', ') || 'none chosen';
      if (reasons.length) {
        this.missions.transition(m.id, 'AWAITING_SCOPE_APPROVAL', { title: 'Plan ready for your approval', detail: reasons.join('\n'), patch: { plan } });
        this.notifier.notify(m.id, 'plan', [
          'Orbit has a plan and is waiting for approval in the dashboard.',
          `Plan: ${truncate(plan.summary, 500)}`,
          `Repositories: ${repoLine}`,
          ...plan.questions.slice(0, 5).map((q) => `Question: ${truncate(q, 300)}`),
        ]);
      } else {
        this.ctx.db
          .insert(approvals)
          .values({
            id: newId('apr'),
            missionId: m.id,
            kind: 'scope',
            decision: 'approved',
            decidedBy: { type: 'system', name: 'Orbit' },
            notes: 'Auto-approved: one authorized repository, verified trigger, no open questions.',
            data: { repoIds: selections.map((s) => s.repoId) },
            createdAt: ts,
          })
          .run();
        this.missions.transition(m.id, 'QUEUED', { title: 'Scope auto-approved (one repository, verified trigger)', patch: { plan } });
        this.queue.enqueue({ type: 'mission.execute', missionId: m.id, dedupeKey: `execute:${m.id}` });
        this.notifier.notify(m.id, 'plan', ['Orbit picked up this task and started implementing.', `Plan: ${truncate(plan.summary, 500)}`, `Repository: ${repoLine}`]);
      }
    });
  };

  // ---------------------------------------------------------------------------
  // Stage 2: execute (worktree → engineer → verify → review, with fix loops)
  // ---------------------------------------------------------------------------

  private async prepareWorktree(m: MissionRow, mr: MissionRepoRow, repo: RepoRow): Promise<MissionRepoRow> {
    const git = this.ctx.git;
    if (mr.worktreePath && existsSync(mr.worktreePath) && mr.baseSha) return mr;
    if (!existsSync(repo.localPath) || !(await git.isRepo(repo.localPath))) throw new BlockedError(`Repository ${repo.name} is missing at ${repo.localPath}.`);

    const wtRoot = path.join(worktreeRoot(this.ctx), `${slugify(repo.name, 30)}-${shortId(repo.id)}`);
    let wtPath = path.join(wtRoot, shortId(m.id));
    for (let n = 2; existsSync(wtPath); n++) wtPath = path.join(wtRoot, `${shortId(m.id)}-${n}`);

    if (mr.branch && mr.baseSha && (await git.branchExists(repo.localPath, mr.branch))) {
      // The worktree folder was deleted but the branch survived: re-attach it.
      await git.worktreePrune(repo.localPath);
      await git.run(repo.localPath, ['worktree', 'add', wtPath, mr.branch]);
      recordMissionEvent(this.ctx, m.id, { kind: 'note', actor: 'git', title: `Re-attached worktree for ${mr.branch}`, detail: wtPath, missionRepoId: mr.id });
      return this.missions.updateMissionRepo(mr.id, { worktreePath: wtPath, status: 'in_progress' });
    }

    const hasRemote = await git.hasRemote(repo.localPath);
    if (hasRemote && !(await git.fetch(repo.localPath))) {
      recordMissionEvent(this.ctx, m.id, { kind: 'note', actor: 'git', title: `Could not fetch ${repo.name}; using local refs`, missionRepoId: mr.id });
    }
    const remoteRef = `origin/${repo.defaultBranch}`;
    const baseRef = hasRemote && (await git.tryRevParse(repo.localPath, remoteRef)) ? remoteRef : repo.defaultBranch;
    const baseSha = await git.tryRevParse(repo.localPath, baseRef);
    if (!baseSha) throw new BlockedError(`${repo.name} has no commits on ${repo.defaultBranch}. Set the default branch in Projects.`);

    const baseBranch = `orbit/${shortId(m.id)}-${slugify(m.title, 30)}`;
    let branch = baseBranch;
    for (let n = 2; await git.branchExists(repo.localPath, branch); n++) branch = `${baseBranch}-${n}`;
    if (!(await git.isValidBranchName(repo.localPath, branch))) branch = `orbit/${shortId(m.id)}`;

    await git.worktreeAdd(repo.localPath, wtPath, branch, baseSha);
    recordMissionEvent(this.ctx, m.id, {
      kind: 'note',
      actor: 'git',
      title: `Created isolated worktree on ${branch} from ${baseRef} (${baseSha.slice(0, 8)})`,
      detail: wtPath,
      missionRepoId: mr.id,
    });
    return this.missions.updateMissionRepo(mr.id, { branch, baseBranch: repo.defaultBranch, baseSha, worktreePath: wtPath, status: 'in_progress', lastError: null });
  }

  /**
   * Setup commands (installs, codegen) must not show up as the engineer's work.
   * Tracked files they modified are restored; files they created are excluded from staging.
   */
  private async isolateSetupArtifacts(m: MissionRow, mr: MissionRepoRow, cwd: string): Promise<MissionRepoRow> {
    const entries = await this.ctx.git.status(cwd, 'normal');
    const created = entries
      .filter((e) => e.code === '??')
      .map((e) => e.path.replace(/\/$/, ''))
      .slice(0, 200);
    const modified = entries.filter((e) => e.code !== '??').map((e) => e.path);
    if (modified.length) {
      await this.ctx.git.run(cwd, ['checkout', '--', ...modified.map((p) => `:(literal)${p}`)]);
      recordMissionEvent(this.ctx, m.id, { kind: 'note', actor: 'git', title: `Setup changed ${modified.length} tracked file(s); restored them`, detail: modified.join('\n'), missionRepoId: mr.id });
    }
    const artifacts = [...new Set([...(mr.setupArtifacts ?? []), ...created])];
    if (created.length) {
      recordMissionEvent(this.ctx, m.id, { kind: 'note', actor: 'git', title: `Setup created ${created.length} file(s) that will not be part of the change`, detail: created.join('\n'), missionRepoId: mr.id });
    }
    return this.missions.updateMissionRepo(mr.id, { setupArtifacts: artifacts });
  }

  private allRepoIds(): string[] {
    return this.repoService.list().map((r) => r.id);
  }

  /**
   * Fresh read-only copies of the mission's reference projects. Agents get the copy,
   * never your real folder, so nothing they do can change it.
   */
  private prepareReferences(m: MissionRow): ReferenceBrief[] {
    const out: ReferenceBrief[] = [];
    for (const ref of this.repoService.rowsByIds(m.referenceRepoIds ?? [])) {
      if (!existsSync(ref.localPath)) {
        recordMissionEvent(this.ctx, m.id, { kind: 'error', actor: 'system', title: `Reference ${ref.name} is missing at ${ref.localPath}; continuing without it` });
        continue;
      }
      const dest = path.join(worktreeRoot(this.ctx), '_references', shortId(m.id), slugify(ref.name, 40));
      const res = snapshotFolder(ref.localPath, dest);
      recordMissionEvent(this.ctx, m.id, {
        kind: 'note',
        actor: 'system',
        title: `Prepared a read-only copy of ${ref.name} (${res.files} files)`,
        detail: res.skipped.length ? `Not copied:\n${res.skipped.slice(0, 40).map((s) => `${s.path}: ${s.reason}`).join('\n')}` : null,
      });
      out.push({ name: ref.name, path: dest, ...(ref.summary?.description ? { description: ref.summary.description } : {}) });
    }
    return out;
  }

  private requireConsent(reason: string): void {
    if (!this.ctx.settings.get().execution.localExecutionConsentAt) {
      throw new BlockedError(`${reason} needs your consent to run commands on this machine.`, 'needs_consent');
    }
  }

  private async runCommands(o: {
    m: MissionRow;
    mr: MissionRepoRow;
    kind: 'setup' | 'verify';
    commands: CommandSpec[];
    cwd: string;
    jctx: JobContext;
  }): Promise<VerificationRow[]> {
    const settings = this.ctx.settings.get();
    const out: VerificationRow[] = [];
    for (const cmd of o.commands.filter((c) => c.enabled)) {
      if (o.jctx.signal.aborted) break;
      const id = newId('ver');
      const startedAt = nowIso(this.ctx);
      this.ctx.db
        .insert(verifications)
        .values({ id, missionId: o.m.id, missionRepoId: o.mr.id, iteration: o.m.iteration, kind: o.kind, label: cmd.label, command: cmd.command, status: 'running', startedAt })
        .run();
      recordMissionEvent(this.ctx, o.m.id, {
        kind: 'command',
        actor: 'system',
        title: `Running ${cmd.label}: ${cmd.command}`,
        missionRepoId: o.mr.id,
        data: { verificationId: id, phase: 'start', label: cmd.label, command: cmd.command } satisfies CommandEventData,
      });
      let status: VerificationRow['status'];
      let exitCode: number | null = null;
      let output = '';
      let durationMs = 0;
      try {
        const parsed = parseCommandLine(cmd.command);
        const timeoutMs = Math.min(cmd.timeoutSec * 1000, settings.execution.commandTimeoutMinutes * 60_000);
        const res = await this.ctx.runner.run(parsed.file, parsed.args, {
          cwd: o.cwd,
          timeoutMs,
          signal: o.jctx.signal,
          killTree: true,
          env: verificationEnv(this.ctx.env),
          extendEnv: false,
          onOutput: () => o.jctx.heartbeat(),
        });
        exitCode = res.exitCode;
        durationMs = res.durationMs;
        output = res.output || res.errorMessage || '';
        status = res.ok ? 'passed' : res.timedOut ? 'timeout' : res.spawnFailed ? 'error' : res.cancelled ? 'error' : 'failed';
        if (res.spawnFailed) output = `Could not start "${parsed.file}". Is it installed and on PATH?\n${output}`;
      } catch (err) {
        status = 'error';
        output = errorMessage(err);
      }
      const row = this.ctx.db
        .update(verifications)
        .set({ status, exitCode, durationMs, outputTail: tail(redactSecrets(output), 12_000), finishedAt: nowIso(this.ctx) })
        .where(eq(verifications.id, id))
        .returning()
        .get();
      if (row) out.push(row);
      recordMissionEvent(this.ctx, o.m.id, {
        kind: status === 'passed' ? 'command' : 'error',
        actor: 'system',
        title: `${cmd.label} ${status === 'passed' ? 'passed' : status} in ${formatDuration(durationMs)}`,
        detail: status === 'passed' ? null : tail(redactSecrets(output), 3000),
        missionRepoId: o.mr.id,
        data: { verificationId: id, phase: 'end', label: cmd.label, command: cmd.command, status } satisfies CommandEventData,
      });
    }
    return out;
  }

  private async review(o: { m: MissionRow; mr: MissionRepoRow; cwd: string; engineerSummary: string; checks: VerificationRow[]; jctx: JobContext; references: ReferenceBrief[] }) {
    const settings = this.ctx.settings.get();
    const diff = await this.ctx.git.diffStaged(o.cwd, o.mr.baseSha as string);
    const stats = await this.ctx.git.diffStatsStaged(o.cwd, o.mr.baseSha as string);
    const limit = 120_000;
    const { result, runId } = await this.runAgent({
      mission: o.m,
      missionRepoId: o.mr.id,
      role: 'reviewer',
      jctx: o.jctx,
      request: {
        prompt: reviewerPrompt({
          req: this.requirement(o.m),
          acceptanceCriteria: o.m.plan?.acceptanceCriteria ?? [],
          engineerSummary: o.engineerSummary,
          diff: diff.length > limit ? diff.slice(0, limit) : diff,
          diffTruncated: diff.length > limit,
          files: stats.fileList,
          checks: o.checks.map((c) => ({ label: c.label, command: c.command, status: c.status, outputTail: c.outputTail })),
          setupArtifacts: o.mr.setupArtifacts ?? [],
          references: o.references,
        }),
        systemAppend: REVIEWER_SYSTEM,
        cwd: o.cwd,
        readRoots: o.references.map((r) => r.path),
        access: 'read-only',
        maxTurns: Math.min(settings.execution.maxTurns, 30),
        timeoutMs: Math.min(settings.execution.agentTimeoutMinutes, 15) * 60_000,
        outputSchema: reviewerOutputSchema as unknown as Record<string, unknown>,
      },
    });
    if (result.status === 'cancelled') throw new BlockedError('__cancelled__');
    const parsed = ReviewerOutput.safeParse(result.structured);
    if (result.status !== 'succeeded' || !parsed.success) {
      recordMissionEvent(this.ctx, o.m.id, {
        kind: 'error',
        actor: 'reviewer',
        title: 'Automated review unavailable for this iteration',
        detail: result.error ?? 'The reviewer did not return a valid review.',
        missionRepoId: o.mr.id,
      });
      return null;
    }
    const findings: ReviewFinding[] = parsed.data.findings.map((f) => ({
      severity: f.severity,
      title: truncate(f.title, 200),
      detail: truncate(f.detail, 2000),
      ...(f.file ? { file: f.file } : {}),
      line: f.line ?? null,
      ...(f.suggestion ? { suggestion: truncate(f.suggestion, 1000) } : {}),
    }));
    const row = this.ctx.db
      .insert(reviews)
      .values({
        id: newId('rvw'),
        missionId: o.m.id,
        missionRepoId: o.mr.id,
        iteration: o.m.iteration,
        verdict: parsed.data.verdict,
        summary: truncate(redactSecrets(parsed.data.summary), 4000),
        findings,
        criteria: parsed.data.criteria.slice(0, 30),
        agentRunId: runId,
        createdAt: nowIso(this.ctx),
      })
      .returning()
      .get();
    const counts = ['blocker', 'major', 'minor', 'nit'].map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(', ');
    recordMissionEvent(this.ctx, o.m.id, {
      kind: 'agent',
      actor: 'reviewer',
      title: `Review: ${parsed.data.verdict === 'approve' ? 'approve' : 'changes requested'} (${counts})`,
      detail: parsed.data.summary,
      missionRepoId: o.mr.id,
    });
    return row ?? null;
  }

  /**
   * The security reviewer: a second, security-only look at the same diff. Critical and
   * high findings go back to the engineer like blocking review findings.
   */
  private async securityReview(o: { m: MissionRow; mr: MissionRepoRow; cwd: string; jctx: JobContext }) {
    const settings = this.ctx.settings.get();
    if (!settings.team.securityReview) return null;
    const diff = await this.ctx.git.diffStaged(o.cwd, o.mr.baseSha as string);
    if (!diff.trim()) return null;
    const stats = await this.ctx.git.diffStatsStaged(o.cwd, o.mr.baseSha as string);
    const limit = 120_000;
    const { result, runId } = await this.runAgent({
      mission: o.m,
      missionRepoId: o.mr.id,
      role: 'security',
      jctx: o.jctx,
      request: {
        prompt: securityPrompt({ taskTitle: this.requirement(o.m).title, diff: diff.length > limit ? diff.slice(0, limit) : diff, diffTruncated: diff.length > limit, files: stats.fileList.map((f) => f.path) }),
        systemAppend: SECURITY_SYSTEM,
        cwd: o.cwd,
        readRoots: [],
        access: 'read-only',
        maxTurns: Math.min(settings.execution.maxTurns, 25),
        timeoutMs: Math.min(settings.execution.agentTimeoutMinutes, 15) * 60_000,
        outputSchema: securityOutputSchema as unknown as Record<string, unknown>,
      },
    });
    if (result.status === 'cancelled') throw new BlockedError('__cancelled__');
    const parsed = SecurityOutput.safeParse(result.structured);
    if (result.status !== 'succeeded' || !parsed.success) {
      recordMissionEvent(this.ctx, o.m.id, {
        kind: 'error',
        actor: 'security',
        title: 'Security review unavailable for this iteration',
        detail: result.error ?? 'The security reviewer did not return a valid review.',
        missionRepoId: o.mr.id,
      });
      return null;
    }
    const SEVERITY = { critical: 'blocker', high: 'major', medium: 'minor', low: 'nit' } as const;
    const findings: ReviewFinding[] = parsed.data.findings.map((f) => ({
      severity: SEVERITY[f.severity],
      title: truncate(`${f.category && f.category.toLowerCase() !== 'security' ? `${f.category}: ` : ''}${f.title}`, 200),
      detail: truncate(f.detail, 2000),
      ...(f.file ? { file: f.file } : {}),
      line: f.line ?? null,
      ...(f.suggestion ? { suggestion: truncate(f.suggestion, 1000) } : {}),
    }));
    const blocking = findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
    const row = this.ctx.db
      .insert(reviews)
      .values({
        id: newId('rvw'),
        kind: 'security',
        missionId: o.m.id,
        missionRepoId: o.mr.id,
        iteration: o.m.iteration,
        verdict: blocking.length ? 'request_changes' : 'approve',
        summary: truncate(redactSecrets(parsed.data.summary), 4000),
        findings,
        criteria: [],
        agentRunId: runId,
        createdAt: nowIso(this.ctx),
      })
      .returning()
      .get();
    const counts = (['critical', 'high', 'medium', 'low'] as const).map((s) => `${parsed.data.findings.filter((f) => f.severity === s).length} ${s}`).join(', ');
    recordMissionEvent(this.ctx, o.m.id, {
      kind: blocking.length ? 'error' : 'agent',
      actor: 'security',
      title: `Security review: ${blocking.length ? 'issues found' : 'no blocking issues'} (${counts})`,
      detail: parsed.data.summary,
      missionRepoId: o.mr.id,
    });
    return row ?? null;
  }

  private bumpIteration(m: MissionRow): MissionRow {
    const next = m.iteration + 1;
    this.ctx.db.update(missionsTable).set({ iteration: next, updatedAt: nowIso(this.ctx) }).where(eq(missionsTable.id, m.id)).run();
    return this.missions.row(m.id);
  }

  execute = async (job: JobRow, jctx: JobContext): Promise<void> => {
    await this.guard(job, async (start) => {
      let m = start;
      if (m.status === 'QUEUED') m = this.missions.transition(m.id, 'RUNNING', { title: 'Implementation started' });
      else if (m.status === 'VERIFYING') m = this.missions.transition(m.id, 'RUNNING', { title: 'Resuming after an interruption' });
      else if (m.status !== 'RUNNING') return;
      if (!m.plan) throw new BlockedError('This mission has no approved plan. Replan it.');
      const settings = this.ctx.settings.get();
      if (settings.execution.mode === 'trusted-local') this.requireConsent('Trusted-local mode (agents run without a sandbox)');
      const runtime = (await this.readySeat('engineer')).primary.runtime;

      const work = this.missions.missionRepoRows(m.id).filter((r) => ['selected', 'in_progress', 'failed'].includes(r.status));
      if (work.length === 0 && !this.missions.missionRepoRows(m.id).some((r) => r.status === 'ready_for_review')) throw new BlockedError('No repositories are selected for this mission.');

      // Developer notes from "Request changes", if newer than the last engineer run.
      const lastChange = this.ctx.db
        .select()
        .from(approvals)
        .where(and(eq(approvals.missionId, m.id), eq(approvals.kind, 'changes'), eq(approvals.decision, 'changes_requested')))
        .orderBy(desc(approvals.createdAt))
        .limit(1)
        .get();
      const lastEngineer = this.ctx.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.missionId, m.id), eq(agentRuns.role, 'engineer')))
        .orderBy(desc(agentRuns.startedAt))
        .limit(1)
        .get();
      const userNotes = lastChange && (!lastEngineer || lastChange.createdAt > lastEngineer.startedAt) ? lastChange.notes : null;
      // Notes written when approving the scope often answer the planner's open questions.
      const scopeNotes =
        this.ctx.db
          .select()
          .from(approvals)
          .where(and(eq(approvals.missionId, m.id), eq(approvals.kind, 'scope'), eq(approvals.decision, 'approved')))
          .orderBy(desc(approvals.createdAt))
          .limit(1)
          .get()?.notes ?? null;
      const references = this.prepareReferences(m);

      for (const initial of work) {
        if (jctx.signal.aborted) throw new BlockedError('__cancelled__');
        const repo = this.repoService.getRow(initial.repoId);
        let mr = await this.prepareWorktree(m, initial, repo);
        const cwd = mr.worktreePath as string;

        const setupCommands = repo.setupCommands.filter((c) => c.enabled);
        const setupDone = this.ctx.db
          .select()
          .from(verifications)
          .where(and(eq(verifications.missionRepoId, mr.id), eq(verifications.kind, 'setup'), eq(verifications.status, 'passed')))
          .all().length;
        if (setupCommands.length && setupDone < setupCommands.length) {
          this.requireConsent('Running setup commands');
          const res = await this.runCommands({ m, mr, kind: 'setup', commands: setupCommands, cwd, jctx });
          const bad = res.find((r) => r.status !== 'passed');
          if (bad) throw new BlockedError(`Setup command "${bad.command}" ${bad.status} in ${repo.name}. Fix the command in Projects or the repository, then retry.`);
          mr = await this.isolateSetupArtifacts(m, mr, cwd);
        }

        const lastReview = this.ctx.db.select().from(reviews).where(eq(reviews.missionRepoId, mr.id)).orderBy(desc(reviews.createdAt)).limit(1).get();
        let feedback: EngineerFeedback | null = userNotes
          ? { failingChecks: [], reviewFindings: (lastReview?.findings ?? []).filter((f) => f.severity !== 'nit'), userNotes }
          : null;
        const selection = mr.selection;
        const verifyCommands = repo.verifyCommands.filter((c) => c.enabled);

        for (let attempt = 0; ; attempt++) {
          m = this.bumpIteration(this.missions.row(m.id));
          if (m.status === 'VERIFYING') m = this.missions.transition(m.id, 'RUNNING', { title: `Fix attempt ${attempt} in ${repo.name}` });
          const { result } = await this.runAgent({
            mission: m,
            missionRepoId: mr.id,
            role: 'engineer',
            jctx,
            request: {
              prompt: engineerPrompt({
                req: this.requirement(m),
                planSummary: m.plan?.summary ?? '',
                steps: m.plan?.steps ?? [],
                acceptanceCriteria: m.plan?.acceptanceCriteria ?? [],
                repoName: repo.name,
                changeSummary: selection?.changeSummary ?? '',
                likelyFiles: selection?.likelyFiles ?? [],
                verifyCommands: verifyCommands.map((c) => c.command),
                ...(repo.summary?.instructionsExcerpt ? { instructionsExcerpt: repo.summary.instructionsExcerpt } : {}),
                scopeNotes,
                openQuestions: m.plan?.questions ?? [],
                references,
                iteration: m.iteration,
                feedback,
              }),
              systemAppend: ENGINEER_SYSTEM,
              cwd,
              readRoots: references.map((r) => r.path),
              access: 'workspace-write',
              maxTurns: settings.execution.maxTurns,
              timeoutMs: settings.execution.agentTimeoutMinutes * 60_000,
              outputSchema: engineerOutputSchema as unknown as Record<string, unknown>,
            },
          });
          if (result.status !== 'succeeded') this.handleAgentFailure(job, m, 'engineer', result);
          const out = EngineerOutput.safeParse(result.structured);
          const report = out.success ? out.data : null;
          if (report?.blocked) throw new BlockedError(`The engineer stopped: ${truncate(report.blockerReason || 'no reason given', 600)}`);
          const engineerSummary = redactSecrets(report?.summary || result.text || '');

          await this.ctx.git.stageAll(cwd, mr.setupArtifacts ?? []);
          const stats = await this.ctx.git.diffStatsStaged(cwd, mr.baseSha as string);
          if (stats.files === 0) {
            mr = this.missions.updateMissionRepo(mr.id, { status: 'no_changes', engineerSummary, diffStats: stats });
            recordMissionEvent(this.ctx, m.id, { kind: 'note', actor: 'engineer', title: `No changes were made in ${repo.name}`, detail: engineerSummary, missionRepoId: mr.id });
            break;
          }
          if (stats.files > 2000) throw new BlockedError(`The change touches ${stats.files} files in ${repo.name}, which looks wrong (check .gitignore for build or dependency folders).`);
          const leaks = scanForSecrets(await this.ctx.git.diffStaged(cwd, mr.baseSha as string));
          if (leaks.length) throw new BlockedError(`The changes in ${repo.name} appear to contain secrets (${leaks.join(', ')}). Review the worktree before continuing.`);
          mr = this.missions.updateMissionRepo(mr.id, { diffStats: stats, engineerSummary, headSha: await this.ctx.git.headSha(cwd) });
          recordMissionEvent(this.ctx, m.id, {
            kind: 'note',
            actor: 'engineer',
            title: `Changed ${stats.files} files in ${repo.name} (+${stats.additions} −${stats.deletions})`,
            detail: engineerSummary,
            missionRepoId: mr.id,
          });

          m = this.missions.transition(m.id, 'VERIFYING', { title: `Verifying ${repo.name}` });
          let checks: VerificationRow[] = [];
          if (verifyCommands.length) {
            this.requireConsent('Running verification commands');
            checks = await this.runCommands({ m, mr, kind: 'verify', commands: verifyCommands, cwd, jctx });
          } else {
            recordMissionEvent(this.ctx, m.id, { kind: 'note', actor: 'system', title: `No verification commands configured for ${repo.name}`, missionRepoId: mr.id });
          }
          if (jctx.signal.aborted) throw new BlockedError('__cancelled__');
          const review = await this.review({ m, mr, cwd, engineerSummary, checks, jctx, references });
          if (jctx.signal.aborted) throw new BlockedError('__cancelled__');
          const security = await this.securityReview({ m, mr, cwd, jctx });

          const failing = checks.filter((c) => c.status !== 'passed' && c.status !== 'skipped');
          const reviewBlocking = review?.verdict === 'request_changes' ? (review.findings ?? []).filter((f) => f.severity === 'blocker' || f.severity === 'major') : [];
          const securityBlocking = (security?.findings ?? []).filter((f) => f.severity === 'blocker' || f.severity === 'major').map((f) => ({ ...f, title: `Security: ${f.title}` }));
          const blocking = [...reviewBlocking, ...securityBlocking];
          const needsFix = failing.length > 0 || blocking.length > 0;
          if (needsFix && attempt < settings.execution.maxFixIterations) {
            feedback = {
              failingChecks: failing.map((c) => ({ label: c.label, command: c.command, outputTail: c.outputTail })),
              reviewFindings: blocking.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail, ...(f.file ? { file: f.file } : {}) })),
              userNotes: null,
            };
            recordMissionEvent(this.ctx, m.id, {
              kind: 'note',
              actor: 'system',
              title: `Sending back to the engineer: ${failing.length} failing check(s), ${blocking.length} blocking finding(s) (fix ${attempt + 1} of ${settings.execution.maxFixIterations})`,
              missionRepoId: mr.id,
            });
            continue;
          }
          mr = this.missions.updateMissionRepo(mr.id, { status: 'ready_for_review' });
          break;
        }
      }

      const all = this.missions.missionRepoRows(m.id).filter((r) => !['excluded', 'discarded', 'proposed'].includes(r.status));
      if (all.every((r) => r.status === 'no_changes')) throw new BlockedError('The engineer finished without changing any files. Add detail to the task or request a different approach.');
      m = this.missions.row(m.id);
      if (m.status === 'RUNNING') m = this.missions.transition(m.id, 'VERIFYING', { title: 'Wrapping up' });
      const latestChecks = this.ctx.db.select().from(verifications).where(and(eq(verifications.missionId, m.id), eq(verifications.iteration, m.iteration), eq(verifications.kind, 'verify'))).all();
      const failingNow = latestChecks.filter((c) => c.status !== 'passed').length;
      this.missions.transition(m.id, 'AWAITING_REVIEW', {
        title: failingNow ? `Ready for review (${failingNow} check(s) still failing)` : 'Ready for your review',
      });
      const files = all.reduce((n, r) => n + (r.diffStats?.files ?? 0), 0);
      this.notifier.notify(m.id, 'review', [
        'Orbit finished implementing this task. Changes are ready for review in the dashboard (nothing has been pushed).',
        `Files changed: ${files}${failingNow ? ` · ${failingNow} check(s) failing` : latestChecks.length ? ' · all checks passed' : ''}`,
      ]);
      audit(this.ctx, { actor: 'orbit', action: 'mission.ready_for_review', target: m.id, summary: `Mission ${m.id} ready for review` });
    });
  };

  // ---------------------------------------------------------------------------
  // Stage 3: publish (push + pull request) after explicit approval
  // ---------------------------------------------------------------------------

  publish = async (job: JobRow): Promise<void> => {
    const { missionRepoId, draft } = job.payload as { missionRepoId: string; draft?: boolean };
    const mr = this.missions.missionRepoRow(missionRepoId);
    const m = this.missions.row(mr.missionId);
    if (m.status !== 'AWAITING_PR_APPROVAL' || mr.status !== 'publishing') return;
    const repo = this.repoService.getRow(mr.repoId);
    const nameWithOwner = `${repo.githubOwner}/${repo.githubRepo}`;
    const cwd = mr.worktreePath && existsSync(mr.worktreePath) ? mr.worktreePath : repo.localPath;
    const branch = mr.branch as string;
    const sha = mr.commitSha as string;
    try {
      const pushed = await this.outbox.perform(
        `git.push:${mr.id}:${sha}`,
        { kind: 'git.push', missionId: m.id, missionRepoId: mr.id, request: { repo: nameWithOwner, branch, sha } },
        {
          check: async () => ((await this.ctx.git.remoteBranchSha(cwd, branch)) === sha ? { sha, branch } : null),
          execute: async () => {
            if ((await this.ctx.git.remoteBranchSha(cwd, branch)) === sha) return { sha, branch };
            await this.ctx.git.push(cwd, branch);
            return { sha, branch };
          },
        },
      );
      recordMissionEvent(this.ctx, m.id, { kind: 'external', actor: 'github', title: pushed.reused ? `Branch ${branch} was already on GitHub` : `Pushed ${branch} to ${nameWithOwner}`, missionRepoId: mr.id });

      const pr = await this.outbox.perform(
        `github.pr:${mr.id}`,
        { kind: 'github.pr', missionId: m.id, missionRepoId: mr.id, request: { repo: nameWithOwner, head: branch, base: mr.prBase } },
        {
          check: () => this.ctx.github.findPullRequest(nameWithOwner, branch),
          execute: async () => {
            const existing = await this.ctx.github.findPullRequest(nameWithOwner, branch);
            if (existing) return existing;
            return this.ctx.github.createPullRequest({
              repo: nameWithOwner,
              base: mr.prBase ?? repo.defaultBranch,
              head: branch,
              title: mr.prTitle ?? m.title,
              body: mr.prBody ?? '',
              draft: draft === true,
            });
          },
        },
      );
      this.missions.updateMissionRepo(mr.id, { status: 'pr_created', prNumber: pr.result.number, prUrl: pr.result.url, prState: pr.result.state, lastError: null });
      recordMissionEvent(this.ctx, m.id, {
        kind: 'external',
        actor: 'github',
        title: pr.reused ? `Pull request #${pr.result.number} already existed` : `Opened pull request #${pr.result.number}`,
        detail: pr.result.url,
        missionRepoId: mr.id,
      });
      audit(this.ctx, { actor: 'orbit', action: 'github.pr_created', target: pr.result.url, summary: `Pull request #${pr.result.number} for ${nameWithOwner}` });

      const rest = this.missions.missionRepoRows(m.id).filter((r) => !['excluded', 'discarded', 'proposed', 'no_changes'].includes(r.status));
      if (rest.every((r) => r.status === 'pr_created' || r.status === 'local_only')) {
        this.missions.transition(m.id, 'PR_CREATED', { title: rest.length > 1 ? 'All pull requests are open' : 'Pull request is open' });
        const links = rest.filter((r) => r.prUrl).map((r) => `Pull request: ${r.prUrl}`);
        this.notifier.notify(m.id, 'pr', ['Orbit opened a pull request for this task. It has not been merged.', ...links]);
      } else {
        this.ctx.bus.publish({ type: 'mission.updated', missionId: m.id, status: m.status });
      }
    } catch (err) {
      const msg = redactSecrets(errorMessage(err));
      this.missions.updateMissionRepo(mr.id, { status: 'changes_approved', lastError: msg });
      recordMissionEvent(this.ctx, m.id, { kind: 'error', actor: 'github', title: `Publishing to ${nameWithOwner} failed`, detail: msg, missionRepoId: mr.id });
      this.ctx.bus.publish({ type: 'mission.updated', missionId: m.id, status: m.status });
    }
  };
}

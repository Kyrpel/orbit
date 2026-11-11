import { PROMPTER_SYSTEM, PrompterOutput, prompterOutputSchema, prompterPrompt, type AgentRunRequest, type AgentRunResult } from '@orbit/agents';
import { OrbitError, truncate, type RepoDTO, type TaskImprovementDTO } from '@orbit/shared';
import { audit, type OrbitContext } from './context';
import type { IntegrationService } from './integrations';
import type { GatewayProvider } from './gateways';
import type { RepoService } from './repos';
import { forgetResolvedRuntime } from './runtimes';
import { forgetCodexAvailability, planSeat, type SeatCandidate } from './team';

const PROMPTER_TIMEOUT_MS = 5 * 60_000;

/**
 * The Prompt engineer: turns rough tasks into clear, complete ones.
 *
 * It reads the task (and the projects it is mapped to, read-only) and proposes a
 * rewrite. Nothing is written back to the tracker until the developer reviews the
 * proposal and clicks apply.
 */
export class PromptEngineer {
  constructor(
    private readonly ctx: OrbitContext,
    private readonly integrations: IntegrationService,
    private readonly repos: RepoService,
    /** OpenRouter and your Hugging Face endpoints (see `ChatService`). */
    private readonly gateways: GatewayProvider[] = [],
  ) {}

  /** Proposes a better version of a tracker task. Read-only. */
  async improveTask(projectId: string, taskId: string): Promise<TaskImprovementDTO> {
    const project = this.integrations.projectRow(projectId);
    const provider = this.integrations.providerFor(project.integrationId);
    const [task, comments] = await Promise.all([provider.getTask(taskId), provider.listComments(taskId, { limit: 10 }).catch(() => [])]);
    const repoIds = this.integrations.projectToDTO(project).repoIds;
    const repos = this.repos.list().filter((r) => repoIds.includes(r.id));
    const out = await this.run({
      title: task.title,
      description: task.description,
      comments: comments.map((c) => ({ ...(c.author?.name ? { author: c.author.name } : {}), text: c.text })),
      repos,
      purpose: 'task',
    });
    return { ...out, original: { title: task.title, description: task.description } };
  }

  /** Writes the approved rewrite back to the tracker task. */
  async applyTask(projectId: string, taskId: string, input: { title: string; description: string }): Promise<{ url: string | null }> {
    const project = this.integrations.projectRow(projectId);
    const provider = this.integrations.providerFor(project.integrationId);
    if (!provider.updateTask) throw new OrbitError('NOT_CONFIGURED', `${provider.displayName} does not support editing tasks from Orbit.`);
    const title = input.title.trim();
    if (!title) throw new OrbitError('VALIDATION', 'The task needs a title.');
    const updated = await provider.updateTask(taskId, { title, description: input.description });
    audit(this.ctx, { actor: 'user', action: 'task.rewrite', target: taskId, summary: `Updated the ${provider.displayName} task "${truncate(title, 120)}" with the Prompt engineer's rewrite` });
    this.ctx.bus.publish({ type: 'integrations.updated' });
    return { url: updated.url };
  }

  /**
   * Improves a request before it is sent to a working session. Read-only. `gateway`: the session
   * uses OpenRouter or a Hugging Face endpoint, so its own model (or that AI's default) does the
   * rewrite, never Claude or Codex.
   */
  async improveText(input: { text: string; repoId?: string | null; gateway?: { provider: 'openrouter' | 'huggingface' | 'cursor'; model: string | null } | null }): Promise<TaskImprovementDTO> {
    const text = input.text.trim();
    if (!text) throw new OrbitError('VALIDATION', 'Type something to improve first.');
    const repos = input.repoId ? this.repos.list().filter((r) => r.id === input.repoId) : [];
    const firstLine = text.split('\n')[0] ?? text;
    const out = await this.run({ title: truncate(firstLine, 200), description: text, comments: [], repos, purpose: 'session', gateway: input.gateway ?? null });
    return { ...out, original: { title: truncate(firstLine, 200), description: text } };
  }

  private async run(args: { title: string; description: string; comments: { author?: string; text: string }[]; repos: RepoDTO[]; purpose: 'task' | 'session'; gateway?: { provider: 'openrouter' | 'huggingface' | 'cursor'; model: string | null } | null }): Promise<Omit<TaskImprovementDTO, 'original'>> {
    const viaOpenRouter = args.gateway ? await this.gatewaySeat(args.gateway.provider, args.gateway.model) : null;
    const plan = viaOpenRouter ? { primary: viaOpenRouter.candidate, fallback: null } : await planSeat(this.ctx, 'prompter');
    if (!plan.primary || !plan.primary.availability.available) {
      throw new OrbitError('PRECONDITION', plan.primary ? `${plan.primary.runtime.displayName} is not ready: ${plan.primary.availability.reason ?? 'unavailable'}` : 'No AI is connected. Sign in to Claude Code or Codex.');
    }
    const settings = this.ctx.settings.get();
    const [first, ...rest] = args.repos;
    const base: Omit<AgentRunRequest, 'model' | 'effort'> = {
      role: 'prompter',
      prompt: prompterPrompt({
        title: args.title,
        description: args.description,
        comments: args.comments,
        purpose: args.purpose,
        projects: args.repos.map((r) => ({
          name: r.name,
          path: r.localPath,
          ...(r.summary?.description ? { description: r.summary.description } : {}),
          languages: r.summary?.languages ?? [],
          frameworks: r.summary?.frameworks ?? [],
          topLevel: r.summary?.topLevel ?? [],
        })),
      }),
      systemAppend: PROMPTER_SYSTEM,
      cwd: first?.localPath ?? this.ctx.paths.home,
      readRoots: rest.map((r) => r.localPath),
      access: 'read-only',
      maxTurns: 20,
      timeoutMs: PROMPTER_TIMEOUT_MS,
      maxBudgetUsd: settings.execution.maxBudgetUsdPerRun,
      outputSchema: prompterOutputSchema as unknown as Record<string, unknown>,
      execution: { mode: 'trusted-local', allowNetworkTools: false },
    };
    let used: SeatCandidate = plan.primary;
    let result = await this.once(used, viaOpenRouter ? { ...base, gateway: viaOpenRouter.gateway } : base);
    if (result.status === 'rate_limited' && plan.fallback) {
      used = plan.fallback;
      result = await this.once(used, base);
    }
    if (result.status !== 'succeeded') {
      throw new OrbitError('EXTERNAL', result.status === 'rate_limited' ? 'The Prompt engineer hit its usage limit. Try again when it resets.' : `The Prompt engineer could not finish: ${truncate(result.error ?? result.status, 300)}`);
    }
    const parsed = PrompterOutput.safeParse(result.structured);
    if (!parsed.success) throw new OrbitError('EXTERNAL', 'The Prompt engineer did not return a usable rewrite. Try again.');
    return { ...parsed.data, runtime: used.runtime.id, model: used.model };
  }

  /**
   * The session's own model for /improve. It answers in a structured form, which needs tool use;
   * a sleeping Hugging Face endpoint is not woken for it (send a message first).
   */
  private async gatewaySeat(provider: 'openrouter' | 'huggingface' | 'cursor', model: string | null) {
    const gw = this.gateways.find((g) => g.id === provider);
    if (!gw) throw new OrbitError('PRECONDITION', `${provider} is not available here.`);
    const s = await gw.seat(model, { wake: false });
    if (s.gateway && !s.gateway.tools) {
      throw new OrbitError('PRECONDITION', `${gw.info(s.candidate.model ?? '').name} cannot use tools, so it cannot run Improve.`, { hint: 'Pick a model that can work in your project for this session, or improve the text yourself.' });
    }
    return s;
  }

  private async once(seat: SeatCandidate, base: Omit<AgentRunRequest, 'model' | 'effort'>): Promise<AgentRunResult> {
    const result = await seat.runtime.run({ ...base, model: base.gateway ? base.gateway.model : seat.model, effort: base.gateway ? null : seat.effort }, { signal: AbortSignal.timeout(PROMPTER_TIMEOUT_MS + 30_000), onEvent: () => undefined });
    if (result.status === 'rate_limited' || result.status === 'failed') {
      forgetResolvedRuntime(this.ctx);
      forgetCodexAvailability(this.ctx);
    }
    return result;
  }
}

import {
  ASSISTANT_SYSTEM,
  assistantPrompt,
  isAllowableCommand,
  parseAssistantReply,
  SECURITY_CHAT_SYSTEM,
  securityCheckMessage,
  SESSION_READONLY_SYSTEM,
  SESSION_SYSTEM,
  sessionPrompt,
  type AgentRunRequest,
  type AgentRunResult,
  type AssistantProject,
} from '@orbit/agents';
import { asc, desc, eq, inArray, conversationEvents, conversationMessages, conversations, type ConversationMessageRow, type ConversationRow } from '@orbit/database';
import {
  formatDuration,
  newId,
  OrbitError,
  redactSecrets,
  truncate,
  type BlockedCommand,
  type ChatEventDTO,
  type ChatMessageDTO,
  type ConversationDetailDTO,
  type ConversationSummaryDTO,
  type MissionEventKind,
  type MissionSuggestion,
  type RepoDTO,
  type SessionMode,
  type SessionPermissionMode,
} from '@orbit/shared';
import { agentEventRecord } from './agent-events';
import { audit, nowIso, type OrbitContext } from './context';
import type { RepoService } from './repos';
import { forgetResolvedRuntime } from './runtimes';
import { forgetCodexAvailability, planSeat, type SeatCandidate } from './team';
import { repoChanges } from './workspace';

const MAX_MESSAGE = 20_000;
const ASK_MAX_TURNS = 40;

type Provider = ConversationSummaryDTO['provider'];

export interface StartSessionInput {
  message: string;
  /** Working sessions have one project; read-only questions may span several (empty: all). */
  repoIds?: string[];
  mode?: SessionMode;
  provider?: Provider;
  permissionMode?: SessionPermissionMode;
}

/**
 * Sessions with an AI agent, the heart of the workspace.
 *
 * - `edit` sessions work directly in one project, like Claude Code in a terminal:
 *   edits land in the real files, shell commands need the developer's approval once
 *   (Codex runs them inside its own sandbox instead), and the agent's own session is
 *   resumed on every message so it keeps its full context.
 * - `ask` sessions are read-only questions, possibly across several projects.
 *
 * Runs happen in-process, not through the mission queue, so several sessions can
 * work at once and never wait behind a long mission. Every step is stored like a
 * mission event, so the dashboard shows the same live step-by-step view.
 */
export class ChatService {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly ctx: OrbitContext,
    private readonly repos: RepoService,
  ) {}

  list(limit = 200): ConversationSummaryDTO[] {
    const rows = this.ctx.db.select().from(conversations).orderBy(desc(conversations.updatedAt)).limit(limit).all();
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const msgs = this.ctx.db.select().from(conversationMessages).where(inArray(conversationMessages.conversationId, ids)).orderBy(asc(conversationMessages.createdAt)).all();
    return rows.map((r) => this.summary(r, msgs.filter((m) => m.conversationId === r.id)));
  }

  detail(id: string): ConversationDetailDTO {
    const row = this.row(id);
    const msgs = this.ctx.db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, id)).orderBy(asc(conversationMessages.createdAt)).all();
    const events = this.ctx.db.select().from(conversationEvents).where(eq(conversationEvents.conversationId, id)).orderBy(asc(conversationEvents.id)).all();
    return {
      ...this.summary(row, msgs),
      messages: msgs.map(toMessageDTO),
      events: events.map((e) => ({ id: e.id, conversationId: e.conversationId, messageId: e.messageId, ts: e.ts, kind: e.kind as MissionEventKind, actor: e.actor as ChatEventDTO['actor'], title: e.title, detail: e.detail, data: e.data })),
    };
  }

  /** Starts a session with its first message. */
  start(input: StartSessionInput): ConversationDetailDTO {
    const message = this.clean(input.message);
    const repoIds = this.validRepoIds(input.repoIds ?? []);
    const mode = this.allowedMode(input.mode ?? 'ask', repoIds);
    const id = newId('chat');
    const ts = nowIso(this.ctx);
    this.ctx.db
      .insert(conversations)
      .values({
        id,
        title: titleFrom(message),
        repoIds,
        mode,
        provider: input.provider ?? 'auto',
        permissionMode: input.permissionMode ?? this.ctx.settings.get().execution.sessionCommands,
        allowedCommands: [],
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    this.ask(id, message);
    return this.detail(id);
  }

  /** Adds a message to a session and starts the agent on it. */
  send(id: string, input: { message: string; provider?: Provider; mode?: SessionMode; repoIds?: string[]; permissionMode?: SessionPermissionMode }): ConversationDetailDTO {
    this.row(id);
    if (this.running.has(id)) throw new OrbitError('CONFLICT', 'The agent is still working on the previous message.', { hint: 'Wait for it to finish or stop it first.' });
    const message = this.clean(input.message);
    this.update(id, input);
    this.ask(id, message);
    return this.detail(id);
  }

  /** Changes a session's AI, mode or projects; the next message uses them. */
  update(id: string, patch: { provider?: Provider; mode?: SessionMode; repoIds?: string[]; title?: string; permissionMode?: SessionPermissionMode }): ConversationSummaryDTO {
    const row = this.row(id);
    const set: Partial<ConversationRow> = {};
    const repoIds = patch.repoIds ? this.validRepoIds(patch.repoIds) : row.repoIds;
    if (patch.repoIds) set.repoIds = repoIds;
    if (patch.provider && patch.provider !== row.provider) set.provider = patch.provider;
    if (patch.mode && patch.mode !== row.mode) set.mode = this.allowedMode(patch.mode, repoIds);
    if (patch.title?.trim()) set.title = truncate(patch.title.trim(), 120);
    if (patch.permissionMode && patch.permissionMode !== row.permissionMode) {
      set.permissionMode = patch.permissionMode;
      audit(this.ctx, { actor: 'user', action: 'session.permission_mode', target: id, summary: `Commands in a working session: ${patch.permissionMode === 'auto' ? 'auto (safety-checked)' : 'ask first'}` });
    }
    if (Object.keys(set).length) {
      this.ctx.db.update(conversations).set(set).where(eq(conversations.id, id)).run();
      this.ctx.bus.publish({ type: 'chat.updated', conversationId: id });
    }
    const updated = this.row(id);
    return this.summary(updated, this.messages(id));
  }

  /**
   * Starts a security check of a project's uncommitted changes, run by the security
   * reviewer in its own session (so you can ask follow-up questions).
   */
  async securityCheck(repoId: string): Promise<ConversationDetailDTO> {
    const repo = this.repos.getRow(repoId);
    const changes = await repoChanges(this.ctx, repo);
    if (!changes.files.length) throw new OrbitError('PRECONDITION', 'There are no uncommitted changes to check.');
    const limit = 120_000;
    const prompt = securityCheckMessage({ diff: changes.diff.slice(0, limit), diffTruncated: changes.truncated || changes.diff.length > limit, files: changes.files.map((f) => f.path) });
    const id = newId('chat');
    const ts = nowIso(this.ctx);
    this.ctx.db
      .insert(conversations)
      .values({ id, title: `Security check · ${repo.name}`, repoIds: [repo.id], mode: 'ask', seat: 'security', provider: 'auto', allowedCommands: [], createdAt: ts, updatedAt: ts })
      .run();
    const n = changes.files.length;
    this.ask(id, `Check my ${n} uncommitted ${n === 1 ? 'file' : 'files'} for security problems.`, prompt);
    return this.detail(id);
  }

  /** Approves a command the agent asked for and lets it continue. */
  allow(id: string, command: string): ConversationDetailDTO {
    const row = this.row(id);
    const cmd = command.trim();
    if (row.mode !== 'edit') throw new OrbitError('PRECONDITION', 'Commands can only be allowed in a working session.');
    if (!isAllowableCommand(cmd)) throw new OrbitError('VALIDATION', 'This command cannot be allowed automatically. Run it yourself in a terminal.');
    if (!row.allowedCommands.includes(cmd)) {
      this.ctx.db.update(conversations).set({ allowedCommands: [...row.allowedCommands, cmd] }).where(eq(conversations.id, id)).run();
      audit(this.ctx, { actor: 'user', action: 'session.allow_command', target: id, summary: `Allowed a command in a working session: ${truncate(cmd, 200)}` });
    }
    return this.send(id, { message: `I allowed \`${cmd}\`. Run it now and continue where you left off.` });
  }

  /** "Allow everything in this session": switch it to Auto and let the agent continue. */
  allowAll(id: string): ConversationDetailDTO {
    const row = this.row(id);
    if (row.mode !== 'edit') throw new OrbitError('PRECONDITION', 'Commands can only be allowed in a working session.');
    return this.send(id, { message: 'You can now run commands without asking (a safety check still blocks risky ones). Continue where you left off.', permissionMode: 'auto' });
  }

  cancel(id: string): void {
    this.row(id);
    this.running.get(id)?.abort();
  }

  remove(id: string): void {
    this.row(id);
    this.running.get(id)?.abort();
    this.ctx.db.delete(conversations).where(eq(conversations.id, id)).run();
    this.ctx.bus.publish({ type: 'chat.updated', conversationId: id });
  }

  /** After a restart, work that was in progress cannot resume. */
  recover(): number {
    const ts = nowIso(this.ctx);
    const stuck = this.ctx.db.select().from(conversationMessages).where(eq(conversationMessages.status, 'running')).all();
    for (const m of stuck) {
      this.ctx.db.update(conversationMessages).set({ status: 'failed', error: 'Interrupted by an Orbit restart. Send the message again to continue.', finishedAt: ts }).where(eq(conversationMessages.id, m.id)).run();
    }
    return stuck.length;
  }

  /** Stops every running session (Orbit is shutting down). */
  stopAll(): void {
    for (const c of this.running.values()) c.abort();
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** True while a working session is changing this project. */
  isEditing(repoId: string): boolean {
    for (const id of this.running.keys()) {
      const row = this.ctx.db.select().from(conversations).where(eq(conversations.id, id)).get();
      if (row?.mode === 'edit' && row.repoIds.includes(repoId)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------

  /** Stores the visible message and starts the agent on it (`prompt` overrides what the agent receives). */
  private ask(conversationId: string, message: string, prompt?: string): void {
    const ts = nowIso(this.ctx);
    this.ctx.db.insert(conversationMessages).values({ id: newId('msg'), conversationId, role: 'user', content: message, status: 'done', createdAt: ts, finishedAt: ts }).run();
    const answerId = newId('msg');
    this.ctx.db.insert(conversationMessages).values({ id: answerId, conversationId, role: 'assistant', content: '', status: 'running', createdAt: nowIso(this.ctx) }).run();
    this.touch(conversationId);
    const controller = new AbortController();
    this.running.set(conversationId, controller);
    void this.answer(conversationId, answerId, message, controller.signal, prompt)
      .catch((err: Error) => {
        this.finish(answerId, { status: 'failed', error: redactSecrets(err.message) });
      })
      .finally(() => {
        this.running.delete(conversationId);
        this.touch(conversationId);
        const conv = this.ctx.db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
        if (conv?.mode === 'edit') for (const repoId of conv.repoIds) this.ctx.bus.publish({ type: 'repo.changed', repoId });
      });
  }

  private async answer(conversationId: string, messageId: string, visible: string, signal: AbortSignal, prompt?: string): Promise<void> {
    const message = prompt ?? visible;
    const conv = this.row(conversationId);
    const projects = this.projectsFor(conv.repoIds);
    if (!projects.length) {
      this.finish(messageId, { status: 'failed', error: 'This project is no longer connected. Add it again in Projects.' });
      return;
    }
    const plan = await planSeat(this.ctx, conv.seat === 'security' ? 'security' : 'assistant', conv.provider);
    if (!plan.primary || !plan.primary.availability.available) {
      this.finish(messageId, {
        status: 'failed',
        error: plan.primary ? `${plan.primary.runtime.displayName} is not ready: ${plan.primary.availability.reason ?? 'unavailable'}` : 'No AI is connected. Sign in to Claude Code (run `claude`) or Codex (run `codex login`).',
      });
      return;
    }
    const history = this.messages(conversationId)
      .filter((m) => m.status === 'done' && m.id !== messageId)
      .map((m) => ({ role: m.role, content: m.content }));
    // The message just stored is the last history entry; the prompt carries it separately.
    if (history.at(-1)?.role === 'user' && history.at(-1)?.content === visible) history.pop();

    let result = await this.turn(conv, messageId, plan.primary, projects, message, history, signal);
    if (result.status === 'rate_limited' && plan.fallback) {
      this.event(conversationId, messageId, { kind: 'note', actor: 'system', title: `${plan.primary.label} hit its usage limit. Switching to ${plan.fallback.label}.`, detail: result.error, data: null });
      result = await this.turn(this.row(conversationId), messageId, plan.fallback, projects, message, history, signal);
    }

    const blocked = this.blockedFrom(result, this.row(conversationId));
    if (result.status === 'succeeded') {
      if (conv.mode === 'ask') {
        const parsed = parseAssistantReply(result.text);
        this.finish(messageId, { status: 'done', content: parsed.answer || '(Finished without a written answer.)', suggestion: this.suggestion(parsed.mission, projects), blocked, durationMs: result.durationMs });
      } else {
        this.finish(messageId, { status: 'done', content: result.text.trim() || (blocked.length ? 'I need your OK to run a command.' : 'Done.'), blocked, durationMs: result.durationMs });
      }
    } else if (result.status === 'cancelled') {
      this.finish(messageId, { status: 'cancelled', content: result.text ? parseAssistantReply(result.text).answer : '', blocked, durationMs: result.durationMs });
    } else {
      const why =
        result.status === 'rate_limited'
          ? 'The AI hit its usage limit. Try again when it resets, or connect a second AI on the AI team page so Orbit can switch automatically.'
          : result.status === 'timeout'
            ? 'This took too long and was stopped. Try a smaller step.'
            : result.status === 'max_turns'
              ? 'The agent reached its step limit for one message. Send "continue" to let it keep going.'
              : result.status === 'budget_exceeded'
                ? 'The agent reached the spending limit for one message (Settings → Budget per agent run).'
                : (result.error ?? 'The agent failed.');
      this.finish(messageId, { status: 'failed', content: result.text ? result.text.trim() : '', error: truncate(redactSecrets(why), 2000), blocked, durationMs: result.durationMs });
    }
  }

  /** One agent run for a message, resuming the agent's own session when it can. */
  private async turn(
    conv: ConversationRow,
    messageId: string,
    seat: SeatCandidate,
    projects: RepoDTO[],
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    signal: AbortSignal,
  ): Promise<AgentRunResult> {
    const resumeId = seat.runtime.resumable && conv.agentRuntime === seat.runtime.id ? conv.agentSessionId : null;
    let result = await this.runOnce(conv, messageId, seat, projects, message, history, resumeId, signal);
    // A session can disappear (cleared by the CLI, another machine): start fresh with the history instead.
    if (resumeId && result.status === 'failed' && !result.numTurns && !signal.aborted) {
      this.event(conv.id, messageId, { kind: 'note', actor: 'system', title: 'Could not continue the previous session, so the agent starts a fresh one with the conversation so far.', detail: result.error, data: null });
      result = await this.runOnce(conv, messageId, seat, projects, message, history, null, signal);
    }
    if (seat.runtime.resumable && result.sessionId) {
      this.ctx.db.update(conversations).set({ agentSessionId: result.sessionId, agentRuntime: seat.runtime.id }).where(eq(conversations.id, conv.id)).run();
    }
    return result;
  }

  private async runOnce(
    conv: ConversationRow,
    messageId: string,
    seat: SeatCandidate,
    projects: RepoDTO[],
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    resumeId: string | null,
    signal: AbortSignal,
  ): Promise<AgentRunResult> {
    const settings = this.ctx.settings.get();
    const briefs: AssistantProject[] = projects.map((p) => ({
      name: p.name,
      path: p.localPath,
      ...(p.summary?.description ? { description: p.summary.description } : {}),
      languages: p.summary?.languages ?? [],
      frameworks: p.summary?.frameworks ?? [],
      topLevel: p.summary?.topLevel ?? [],
    }));
    const [primary, ...others] = projects;
    const edit = conv.mode === 'edit';
    const intro = !resumeId;
    const base = {
      role: 'assistant' as AgentRunRequest['role'],
      cwd: primary!.localPath,
      timeoutMs: settings.execution.agentTimeoutMinutes * 60_000,
      maxBudgetUsd: settings.execution.maxBudgetUsdPerRun,
      outputSchema: null,
      model: seat.model,
      effort: seat.effort,
      session: { resumeId, persist: true },
      // The developer's own sessions: their skills (design skills included) and user settings load.
      userEnvironment: true,
    };
    const request: AgentRunRequest = edit
      ? {
          ...base,
          prompt: sessionPrompt({ message, project: briefs[0]!, history: intro ? history : [], intro }),
          systemAppend: SESSION_SYSTEM,
          readRoots: [],
          access: 'workspace-write',
          maxTurns: settings.execution.maxTurns,
          // No OS sandbox for Claude here (it does not run on Windows); every command that is not
          // read-only needs the developer's approval instead, as in Claude Code's own terminal.
          // Codex always runs inside its own sandbox.
          execution: { mode: 'trusted-local', allowNetworkTools: settings.execution.allowAgentNetwork },
          commands: {
            mode: conv.permissionMode === 'auto' ? 'auto' : 'allowlist',
            allowed: [...new Set([...this.projectCommands(primary!), ...conv.allowedCommands])],
          },
        }
      : conv.seat === 'security'
        ? {
            ...base,
            role: 'security',
            prompt: message,
            systemAppend: SECURITY_CHAT_SYSTEM,
            readRoots: [],
            access: 'read-only',
            maxTurns: ASK_MAX_TURNS,
            execution: { mode: 'trusted-local', allowNetworkTools: false },
          }
        : {
          ...base,
          prompt: intro ? assistantPrompt({ question: message, history, projects: briefs }) : message,
          systemAppend: projects.length === 1 ? `${SESSION_READONLY_SYSTEM}\n\n${ASSISTANT_SYSTEM}` : ASSISTANT_SYSTEM,
          readRoots: others.map((r) => r.localPath),
          access: 'read-only',
          maxTurns: ASK_MAX_TURNS,
          execution: { mode: 'trusted-local', allowNetworkTools: false },
        };

    const runId = newId('run');
    this.ctx.db.update(conversationMessages).set({ runtime: seat.runtime.id, model: seat.model }).where(eq(conversationMessages.id, messageId)).run();
    const who = edit ? 'Agent' : conv.seat === 'security' ? 'Security reviewer' : 'Assistant';
    this.event(conv.id, messageId, {
      kind: 'agent',
      actor: 'assistant',
      title: `${who} ${resumeId ? 'continued' : 'started'} (${seat.label}${seat.model ? ` · ${seat.model}` : ''})`,
      data: { runId, phase: 'start', runtime: seat.runtime.id, provider: seat.provider, model: seat.model },
    });
    const result = await seat.runtime.run(request, { signal, onEvent: (e) => this.event(conv.id, messageId, { ...agentEventRecord(e, runId), actor: 'assistant' }) });
    if (result.status === 'rate_limited' || result.status === 'failed') {
      forgetResolvedRuntime(this.ctx);
      forgetCodexAvailability(this.ctx);
    }
    const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    this.event(conv.id, messageId, {
      kind: status === 'failed' ? 'error' : 'agent',
      actor: 'assistant',
      title: `${who} ${status === 'succeeded' ? 'finished' : status === 'cancelled' ? 'was stopped' : `stopped (${result.status.replace('_', ' ')})`} after ${formatDuration(result.durationMs)}`,
      detail: result.error,
      data: { runId, phase: 'end', status, numTurns: result.numTurns },
    });
    return result;
  }

  /** Commands a working session may run without asking: the project's own setup and check commands. */
  private projectCommands(repo: RepoDTO): string[] {
    return [...repo.setupCommands, ...repo.verifyCommands].filter((c) => c.enabled && isAllowableCommand(c.command)).map((c) => c.command.trim());
  }

  private blockedFrom(result: AgentRunResult, conv: ConversationRow): BlockedCommand[] {
    if (conv.mode !== 'edit') return [];
    const seen = new Set<string>();
    const out: BlockedCommand[] = [];
    for (const d of result.deniedTools) {
      const command = d.command?.trim();
      if (!command || seen.has(command) || conv.allowedCommands.includes(command)) continue;
      seen.add(command);
      out.push({ tool: d.tool, command, allowable: isAllowableCommand(command) });
    }
    return out.slice(0, 10);
  }

  private suggestion(m: ReturnType<typeof parseAssistantReply>['mission'], projects: RepoDTO[]): MissionSuggestion | null {
    if (!m) return null;
    const byName = new Map(projects.map((p) => [p.name.toLowerCase(), p]));
    const repoIds = m.projects.map((n) => byName.get(n.toLowerCase())).filter((p): p is RepoDTO => !!p && p.allowModify && p.isGit).map((p) => p.id);
    return { title: m.title, description: m.description, repoIds: [...new Set(repoIds)] };
  }

  private event(conversationId: string, messageId: string, input: { kind: MissionEventKind; actor: ChatEventDTO['actor']; title: string; detail?: string | null; data: unknown }): void {
    const row = this.ctx.db
      .insert(conversationEvents)
      .values({ conversationId, messageId, ts: nowIso(this.ctx), kind: input.kind, actor: input.actor, title: truncate(input.title, 500), detail: input.detail ? truncate(input.detail, 20_000) : null, data: input.data ?? null })
      .returning()
      .get();
    if (!row) return;
    this.ctx.bus.publish({
      type: 'chat.event',
      conversationId,
      event: { id: row.id, conversationId, messageId, ts: row.ts, kind: input.kind, actor: input.actor, title: row.title, detail: row.detail, data: row.data },
    });
  }

  private finish(messageId: string, patch: { status: ChatMessageDTO['status']; content?: string; error?: string; suggestion?: MissionSuggestion | null; blocked?: BlockedCommand[]; durationMs?: number }): void {
    this.ctx.db
      .update(conversationMessages)
      .set({
        status: patch.status,
        ...(patch.content !== undefined ? { content: redactSecrets(patch.content) } : {}),
        error: patch.error ?? null,
        suggestion: patch.suggestion ?? null,
        blocked: patch.blocked?.length ? patch.blocked : null,
        durationMs: patch.durationMs ?? null,
        finishedAt: nowIso(this.ctx),
      })
      .where(eq(conversationMessages.id, messageId))
      .run();
  }

  private touch(id: string): void {
    this.ctx.db.update(conversations).set({ updatedAt: nowIso(this.ctx) }).where(eq(conversations.id, id)).run();
    this.ctx.bus.publish({ type: 'chat.updated', conversationId: id });
  }

  private messages(id: string): ConversationMessageRow[] {
    return this.ctx.db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, id)).orderBy(asc(conversationMessages.createdAt)).all();
  }

  private projectsFor(repoIds: string[]): RepoDTO[] {
    const all = this.repos.list();
    if (!repoIds.length) return all;
    return all.filter((r) => repoIds.includes(r.id));
  }

  /** Editing needs exactly one project that Orbit may change; otherwise the session is read-only. */
  private allowedMode(mode: SessionMode, repoIds: string[]): SessionMode {
    if (mode !== 'edit') return 'ask';
    if (repoIds.length !== 1) throw new OrbitError('VALIDATION', 'A working session edits exactly one project.');
    const repo = this.repos.list().find((r) => r.id === repoIds[0]);
    if (!repo) throw new OrbitError('NOT_FOUND', 'Project not found.');
    if (!repo.allowModify || !repo.isGit) {
      throw new OrbitError('PRECONDITION', `${repo.name} is read-only in Orbit.`, { hint: repo.isGit ? 'Allow changes for it in Projects.' : 'Plain folders can be read but not changed. Initialize git in it first.' });
    }
    return 'edit';
  }

  private validRepoIds(ids: string[]): string[] {
    const known = new Set(this.repos.list().map((r) => r.id));
    return [...new Set(ids)].filter((id) => known.has(id));
  }

  private clean(message: string): string {
    const q = message.trim();
    if (!q) throw new OrbitError('VALIDATION', 'Type a message first.');
    if (q.length > MAX_MESSAGE) throw new OrbitError('VALIDATION', `Messages are limited to ${MAX_MESSAGE} characters.`);
    return q;
  }

  private row(id: string): ConversationRow {
    const row = this.ctx.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) throw new OrbitError('NOT_FOUND', 'Session not found.');
    return row;
  }

  private summary(row: ConversationRow, msgs: ConversationMessageRow[]): ConversationSummaryDTO {
    const last = [...msgs].reverse().find((m) => m.content);
    const lastAgent = [...msgs].reverse().find((m) => m.role === 'assistant');
    const running = this.running.has(row.id) || msgs.some((m) => m.status === 'running');
    return {
      id: row.id,
      title: row.title,
      repoIds: row.repoIds,
      mode: row.mode,
      seat: row.seat,
      provider: row.provider,
      agentRuntime: row.agentRuntime,
      allowedCommands: row.allowedCommands,
      permissionMode: row.permissionMode,
      lastMessage: last ? truncate(last.content.replace(/\s+/g, ' '), 140) : null,
      running,
      lastStatus: lastAgent?.status ?? null,
      needsYou: !running && !!lastAgent?.blocked?.some((b) => b.allowable && !row.allowedCommands.includes(b.command)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length > 70 ? `${line.slice(0, 67).trimEnd()}…` : line;
}

function toMessageDTO(m: ConversationMessageRow): ChatMessageDTO {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    status: m.status,
    runtime: m.runtime,
    model: m.model,
    error: m.error,
    suggestion: m.suggestion ?? null,
    blocked: m.blocked ?? [],
    durationMs: m.durationMs,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt,
  };
}

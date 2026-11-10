import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ASSISTANT_SYSTEM,
  assistantPrompt,
  cleanNextPrompt,
  NEXT_PROMPT_SYSTEM,
  nextPromptPrompt,
  deniedCommandReason,
  isAllowableCommand,
  parseAssistantReply,
  SECURITY_CHAT_SYSTEM,
  securityCheckMessage,
  SESSION_READONLY_SYSTEM,
  SESSION_SYSTEM,
  sessionPrompt,
  type AgentImage,
  type AgentRunRequest,
  type AgentRunResult,
  type ApprovalDecision,
  type ApprovalRequest,
  type SteerFn,
  type AssistantProject,
} from '@orbit/agents';
import { asc, desc, eq, inArray, conversationEvents, conversationMessages, conversations, type ConversationMessageRow, type ConversationRow, type StoredAttachment } from '@orbit/database';
import {
  CHAT_IMAGE_LIMITS,
  CHAT_IMAGE_TYPES,
  formatDuration,
  MAX_CHAT_MESSAGE,
  newId,
  type EffortLevel,
  OrbitError,
  redactSecrets,
  truncate,
  type BlockedCommand,
  type ChatEventDTO,
  type ChatImageInput,
  type ChatImageType,
  type ChatMessageDTO,
  type ConversationDetailDTO,
  type ConversationSummaryDTO,
  type MissionEventKind,
  type MissionSuggestion,
  type RepoDTO,
  type SessionApprovalDTO,
  type SessionMode,
  type SessionPermissionMode,
} from '@orbit/shared';
import { agentEventRecord } from './agent-events';
import { audit, nowIso, type OrbitContext } from './context';
import type { RepoService } from './repos';
import { forgetResolvedRuntime } from './runtimes';
import { forgetCodexAvailability, planSeat, type SeatCandidate } from './team';
import { repoChanges } from './workspace';

const MAX_MESSAGE = MAX_CHAT_MESSAGE;
const ASK_MAX_TURNS = 40;
/** Effectively no limit for working sessions: a safety net for a process that hangs for a day. */
const SESSION_TIMEOUT_MS = 24 * 60 * 60_000;
/** Long jobs (a batch, a big refactor) take many steps; Claude Code itself has no step limit. */
const SESSION_MAX_TURNS = 2000;

type Provider = ConversationSummaryDTO['provider'];

export interface StartSessionInput {
  message: string;
  /** Working sessions have one project; read-only questions may span several (empty: all). */
  repoIds?: string[];
  mode?: SessionMode;
  provider?: Provider;
  permissionMode?: SessionPermissionMode;
  model?: string | null;
  effort?: EffortLevel | null;
  /** Images pasted or dropped into the first message. */
  images?: ChatImageInput[];
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
  /** For agents that take messages mid-answer: delivers one right away. */
  private readonly steers = new Map<string, SteerFn>();
  /** Your likely next message, per session, for the answer it follows (`after`). */
  private readonly nextPrompts = new Map<string, { after: string; text: string }>();
  /** Requests the agent is waiting on, oldest first (Codex asking to run what its sandbox blocks). */
  private readonly approvals = new Map<string, { dto: SessionApprovalDTO; messageId: string; runId: string; resolve: (d: ApprovalDecision) => void }[]>();

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
      approval: this.approvals.get(id)?.[0]?.dto ?? null,
      nextPrompt: this.nextPromptFor(id, msgs),
    };
  }

  /** Starts a session with its first message. */
  start(input: StartSessionInput): ConversationDetailDTO {
    const message = this.clean(input.message);
    const repoIds = this.validRepoIds(input.repoIds ?? []);
    decodeImages(input.images);
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
        model: cleanModel(input.model),
        effort: input.effort ?? null,
        allowedCommands: [],
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    this.ask(id, message, undefined, input.images);
    return this.detail(id);
  }

  /** Adds a message to a session and starts the agent on it. */
  /**
   * Adds a message. While the agent is still answering, the message is queued, as in
   * Claude Code, and goes out as soon as the current answer ends; `now` interrupts the
   * current answer so it goes out right away.
   */
  send(id: string, input: { message: string; provider?: Provider; mode?: SessionMode; repoIds?: string[]; permissionMode?: SessionPermissionMode; model?: string | null; effort?: EffortLevel | null; images?: ChatImageInput[]; now?: boolean }): ConversationDetailDTO {
    this.row(id);
    const message = this.clean(input.message);
    decodeImages(input.images);
    this.update(id, input);
    if (this.running.has(id)) {
      const ts = nowIso(this.ctx);
      const msgId = newId('msg');
      const attachments = this.saveImages(id, msgId, input.images);
      // Delivered right away when the agent can take it, like typing into Claude Code while it works.
      const steer = input.now ? undefined : this.steers.get(id);
      if (steer && steer(message, this.agentImages(id, attachments))) {
        this.ctx.db.insert(conversationMessages).values({ id: msgId, conversationId: id, role: 'user', content: message, status: 'steered', attachments, createdAt: ts, finishedAt: ts }).run();
        this.touch(id);
        return this.detail(id);
      }
      this.ctx.db.insert(conversationMessages).values({ id: msgId, conversationId: id, role: 'user', content: message, status: 'queued', attachments, createdAt: ts }).run();
      this.touch(id);
      if (input.now) this.running.get(id)?.abort();
      return this.detail(id);
    }
    this.ask(id, message, undefined, input.images);
    return this.detail(id);
  }

  /** An attached image's file, for the dashboard: only files recorded on this conversation's messages. */
  attachment(id: string, file: string): { path: string; mediaType: string } {
    this.row(id);
    const hit = /^[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(file)
      ? this.ctx.db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, id))
          .all()
          .flatMap((m) => m.attachments ?? [])
          .find((a) => a.file === file)
      : undefined;
    if (!hit) throw new OrbitError('NOT_FOUND', 'Image not found.');
    return { path: path.join(this.ctx.paths.uploads, id, hit.file), mediaType: hit.mediaType };
  }

  /** Takes back a queued message before it is sent. */
  unqueue(id: string, messageId: string): ConversationDetailDTO {
    this.row(id);
    const msg = this.ctx.db.select().from(conversationMessages).where(eq(conversationMessages.id, messageId)).get();
    if (!msg || msg.conversationId !== id) throw new OrbitError('NOT_FOUND', 'Message not found.');
    if (msg.status !== 'queued') throw new OrbitError('CONFLICT', 'This message has already been sent.');
    this.ctx.db.delete(conversationMessages).where(eq(conversationMessages.id, messageId)).run();
    this.touch(id);
    return this.detail(id);
  }

  /** Changes a session's AI, mode or projects; the next message uses them. */
  update(id: string, patch: { provider?: Provider; mode?: SessionMode; repoIds?: string[]; title?: string; permissionMode?: SessionPermissionMode; model?: string | null; effort?: EffortLevel | null }): ConversationSummaryDTO {
    const row = this.row(id);
    const set: Partial<ConversationRow> = {};
    const repoIds = patch.repoIds ? this.validRepoIds(patch.repoIds) : row.repoIds;
    if (patch.repoIds) set.repoIds = repoIds;
    if (patch.provider && patch.provider !== row.provider) set.provider = patch.provider;
    if (patch.mode && patch.mode !== row.mode) set.mode = this.allowedMode(patch.mode, repoIds);
    if (patch.title?.trim()) set.title = truncate(patch.title.trim(), 120);
    if (patch.model !== undefined && cleanModel(patch.model) !== row.model) set.model = cleanModel(patch.model);
    if (patch.effort !== undefined && (patch.effort ?? null) !== row.effort) set.effort = patch.effort ?? null;
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

  /** Answers what the agent is waiting on (see `requestApproval`). */
  approve(id: string, decision: 'accept' | 'acceptForSession' | 'decline'): ConversationDetailDTO {
    this.row(id);
    const list = this.approvals.get(id);
    const next = list?.shift();
    if (!list || !next) throw new OrbitError('CONFLICT', 'The agent is no longer waiting for an answer.');
    if (!list.length) this.approvals.delete(id);
    const label = next.dto.command ?? 'a file change outside its sandbox';
    const allowed = decision !== 'decline';
    audit(this.ctx, { actor: 'user', action: allowed ? 'session.approve' : 'session.decline', target: id, summary: `${allowed ? 'Allowed' : 'Declined'} in a working session: ${truncate(label, 200)}` });
    this.event(id, next.messageId, { kind: 'agent', actor: 'assistant', title: `${allowed ? 'You allowed' : 'You declined'}: ${truncate(label, 160)}`, data: { runId: next.runId } });
    next.resolve(decision);
    this.ctx.bus.publish({ type: 'chat.updated', conversationId: id });
    return this.detail(id);
  }

  cancel(id: string): void {
    this.row(id);
    this.dropApprovals(id);
    this.running.get(id)?.abort();
  }

  remove(id: string): void {
    this.row(id);
    this.dropApprovals(id);
    this.running.get(id)?.abort();
    this.ctx.db.delete(conversations).where(eq(conversations.id, id)).run();
    rmSync(path.join(this.ctx.paths.uploads, id), { recursive: true, force: true });
    this.ctx.bus.publish({ type: 'chat.updated', conversationId: id });
  }

  /** After a restart, work that was in progress cannot resume. */
  recover(): number {
    const ts = nowIso(this.ctx);
    const stuck = this.ctx.db.select().from(conversationMessages).where(eq(conversationMessages.status, 'running')).all();
    for (const m of stuck) {
      this.ctx.db.update(conversationMessages).set({ status: 'failed', error: 'Interrupted by an Orbit restart. Send the message again to continue.', finishedAt: ts }).where(eq(conversationMessages.id, m.id)).run();
    }
    const unsent = this.ctx.db.select().from(conversationMessages).where(eq(conversationMessages.status, 'queued')).all();
    for (const m of unsent) {
      this.ctx.db.update(conversationMessages).set({ status: 'cancelled', error: 'Not sent: Orbit restarted before it could go out.', finishedAt: ts }).where(eq(conversationMessages.id, m.id)).run();
    }
    return stuck.length;
  }

  /** Stops every running session (Orbit is shutting down). */
  stopAll(): void {
    for (const id of [...this.approvals.keys()]) this.dropApprovals(id);
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
  private ask(conversationId: string, message: string, prompt?: string, images?: ChatImageInput[]): void {
    this.nextPrompts.delete(conversationId);
    const ts = nowIso(this.ctx);
    const userId = newId('msg');
    const attachments = this.saveImages(conversationId, userId, images);
    this.ctx.db.insert(conversationMessages).values({ id: userId, conversationId, role: 'user', content: message, status: 'done', attachments, createdAt: ts, finishedAt: ts }).run();
    this.startTurn(conversationId, prompt ?? message, [userId]);
  }

  /** Runs the agent on `text`; `userIds` are the messages it answers (left out of the history). */
  private startTurn(conversationId: string, text: string, userIds: string[]): void {
    const answerId = newId('msg');
    this.ctx.db.insert(conversationMessages).values({ id: answerId, conversationId, role: 'assistant', content: '', status: 'running', createdAt: nowIso(this.ctx) }).run();
    this.touch(conversationId);
    const controller = new AbortController();
    this.running.set(conversationId, controller);
    void this.answer(conversationId, answerId, text, controller.signal, userIds)
      .catch((err: Error) => {
        this.finish(answerId, { status: 'failed', error: redactSecrets(err.message) });
      })
      .finally(() => {
        this.running.delete(conversationId);
        const conv = this.ctx.db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
        if (conv?.mode === 'edit') for (const repoId of conv.repoIds) this.ctx.bus.publish({ type: 'repo.changed', repoId });
        // Messages sent while the agent was busy go out now, together, as the next turn.
        const queued = conv ? this.messages(conversationId).filter((m) => m.role === 'user' && m.status === 'queued') : [];
        if (queued.length) {
          const ts = nowIso(this.ctx);
          for (const m of queued) this.ctx.db.update(conversationMessages).set({ status: 'done', finishedAt: ts }).where(eq(conversationMessages.id, m.id)).run();
          this.startTurn(conversationId, queued.map((m) => m.content).join('\n\n'), queued.map((m) => m.id));
          return;
        }
        this.touch(conversationId);
      });
  }

  private async answer(conversationId: string, messageId: string, message: string, signal: AbortSignal, userIds: string[]): Promise<void> {
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
    // The messages being answered travel in the prompt itself, not in the history.
    const history = this.messages(conversationId)
      .filter((m) => (m.status === 'done' || m.status === 'steered') && m.id !== messageId && !userIds.includes(m.id))
      .map((m) => ({ role: m.role, content: m.content }));

    const images = this.imagesFor(conversationId, userIds);
    let result = await this.turn(conv, messageId, withModel(plan.primary, conv.model, conv.effort), projects, message, history, signal, images);
    if (result.status === 'rate_limited' && plan.fallback) {
      this.event(conversationId, messageId, { kind: 'note', actor: 'system', title: `${plan.primary.label} hit its usage limit. Switching to ${plan.fallback.label}.`, detail: result.error, data: null });
      result = await this.turn(this.row(conversationId), messageId, withModel(plan.fallback, conv.model, conv.effort), projects, message, history, signal, images);
    }

    const blocked = this.blockedFrom(result, this.row(conversationId));
    if (result.status === 'succeeded') {
      if (conv.mode === 'ask') {
        const parsed = parseAssistantReply(result.text);
        this.finish(messageId, { status: 'done', content: parsed.answer || '(Finished without a written answer.)', suggestion: this.suggestion(parsed.mission, projects), blocked, durationMs: result.durationMs });
      } else {
        this.finish(messageId, { status: 'done', content: result.text.trim() || (blocked.length ? 'I need your OK to run a command.' : 'Done.'), blocked, durationMs: result.durationMs });
      }
      if (conv.seat !== 'security' && this.ctx.settings.get().execution.suggestNext) void this.suggestNext(conversationId, messageId);
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
    images: AgentImage[],
  ): Promise<AgentRunResult> {
    const resumeId = seat.runtime.resumable && conv.agentRuntime === seat.runtime.id ? conv.agentSessionId : null;
    let result = await this.runOnce(conv, messageId, seat, projects, message, history, resumeId, signal, images);
    // A session can disappear (cleared by the CLI, another machine): start fresh with the history instead.
    if (resumeId && result.status === 'failed' && !result.numTurns && !signal.aborted) {
      this.event(conv.id, messageId, { kind: 'note', actor: 'system', title: 'Could not continue the previous session, so the agent starts a fresh one with the conversation so far.', detail: result.error, data: null });
      result = await this.runOnce(conv, messageId, seat, projects, message, history, null, signal, images);
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
    images: AgentImage[],
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
      // Working sessions run as long as you let them, like Claude Code (you can always Stop).
      // The per-run time limit in Settings is for Autopilot and quick questions.
      timeoutMs: conv.mode === 'edit' ? SESSION_TIMEOUT_MS : settings.execution.agentTimeoutMinutes * 60_000,
      maxBudgetUsd: conv.mode === 'edit' ? null : settings.execution.maxBudgetUsdPerRun,
      outputSchema: null,
      model: seat.model,
      effort: seat.effort,
      session: { resumeId, persist: true },
      // The developer's own sessions: their skills (design skills included) and user settings load.
      userEnvironment: true,
      ...(images.length ? { images } : {}),
    };
    const request: AgentRunRequest = edit
      ? {
          ...base,
          prompt: sessionPrompt({ message, project: briefs[0]!, history: intro ? history : [], intro }),
          systemAppend: SESSION_SYSTEM,
          readRoots: [],
          access: 'workspace-write',
          maxTurns: SESSION_MAX_TURNS,
          // No OS sandbox for Claude here (it does not run on Windows); every command that is not
          // read-only needs the developer's approval instead, as in Claude Code's own terminal.
          // Codex always runs inside its own sandbox.
          execution: { mode: 'trusted-local', allowNetworkTools: settings.execution.allowAgentNetwork },
          commands: {
            mode: conv.permissionMode === 'auto' ? 'auto' : 'allowlist',
            allowed: [...new Set([...this.projectCommands(primary!), ...conv.allowedCommands])],
          },
          // The developer's own project: the agent commits and pushes when asked, like Claude Code.
          allowGit: true,
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
    const result = await seat.runtime.run(request, {
      signal,
      onEvent: (e) => this.event(conv.id, messageId, { ...agentEventRecord(e, runId), actor: 'assistant' }),
      onSteerReady: (fn) => {
        if (fn) this.steers.set(conv.id, fn);
        else this.steers.delete(conv.id);
        this.ctx.bus.publish({ type: 'chat.updated', conversationId: conv.id });
      },
      ...(edit ? { onApproval: (a: ApprovalRequest) => this.requestApproval(conv.id, messageId, runId, a) } : {}),
    });
    this.steers.delete(conv.id);
    this.dropApprovals(conv.id);
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

  /**
   * The agent asks, mid-answer, to run something its sandbox blocks (Codex: a commit, a push,
   * a download). Orbit's hard rules always apply. In Auto-accept the rest runs on its own;
   * in Ask first the developer answers in the session (`approve`).
   */
  private requestApproval(conversationId: string, messageId: string, runId: string, a: ApprovalRequest): Promise<ApprovalDecision> {
    const row = this.row(conversationId);
    const label = a.command ?? 'a file change outside its sandbox';
    const denied = a.command ? deniedCommandReason(a.command, { allowGit: true }) : null;
    if (denied) {
      this.event(conversationId, messageId, { kind: 'agent', actor: 'assistant', title: `Blocked: ${truncate(label, 160)}. ${denied}`, data: { runId } });
      return Promise.resolve('decline');
    }
    if (row.permissionMode === 'auto' || (a.command && row.allowedCommands.includes(a.command))) {
      this.event(conversationId, messageId, { kind: 'agent', actor: 'assistant', title: `Auto-accepted: ${truncate(label, 160)}`, data: { runId } });
      return Promise.resolve('accept');
    }
    return new Promise((resolve) => {
      const dto: SessionApprovalDTO = { id: newId('apr'), kind: a.kind, command: a.command, reason: a.reason, network: a.network, createdAt: nowIso(this.ctx) };
      this.approvals.set(conversationId, [...(this.approvals.get(conversationId) ?? []), { dto, messageId, runId, resolve }]);
      this.ctx.bus.publish({ type: 'chat.updated', conversationId });
    });
  }

  /** Answers every open request with `cancel` (the answer stopped or the session is going away). */
  private dropApprovals(conversationId: string): void {
    const list = this.approvals.get(conversationId);
    if (!list) return;
    this.approvals.delete(conversationId);
    for (const p of list) p.resolve('cancel');
    this.ctx.bus.publish({ type: 'chat.updated', conversationId });
  }

  /** The suggestion, while it still follows the last answer and nothing new is running. */
  private nextPromptFor(id: string, msgs: ConversationMessageRow[]): string | null {
    const n = this.nextPrompts.get(id);
    const lastAgent = [...msgs].reverse().find((m) => m.role === 'assistant');
    return n && lastAgent?.id === n.after && lastAgent.status === 'done' && !this.running.has(id) ? n.text : null;
  }

  /**
   * Like Claude Code's prompt suggestions: after an answer, a small, cheap model guesses
   * your next message. Optional and best effort: any problem just means no suggestion.
   */
  private async suggestNext(conversationId: string, answerId: string): Promise<void> {
    try {
      const msgs = this.messages(conversationId);
      const at = msgs.findIndex((m) => m.id === answerId);
      const answer = msgs[at];
      if (!answer?.content.trim()) return;
      const request = [...msgs.slice(0, at)].reverse().find((m) => m.role === 'user')?.content ?? '';
      const cwd = this.projectsFor(this.row(conversationId).repoIds)[0]?.localPath;
      const plan = await planSeat(this.ctx, 'prompter');
      const seat = [plan.primary, plan.fallback].find((s) => s?.availability.available && s.runtime.kind === 'ai');
      if (!seat || !cwd) return;
      const result = await seat.runtime.run(
        {
          role: 'prompter',
          prompt: nextPromptPrompt({ request, answer: answer.content }),
          systemAppend: NEXT_PROMPT_SYSTEM,
          cwd,
          readRoots: [],
          access: 'read-only',
          maxTurns: 1,
          timeoutMs: 60_000,
          maxBudgetUsd: null,
          // The smallest, fastest model is plenty for one line.
          model: seat.provider === 'claude' ? 'haiku' : seat.model,
          effort: 'low',
          outputSchema: null,
          execution: { mode: 'trusted-local', allowNetworkTools: false },
        },
        { signal: AbortSignal.timeout(75_000), onEvent: () => undefined },
      );
      const text = result.status === 'succeeded' ? cleanNextPrompt(redactSecrets(result.text)) : null;
      // Only while that answer is still the latest and you have not moved on.
      const latest = [...this.messages(conversationId)].reverse().find((m) => m.role === 'assistant');
      if (!text || latest?.id !== answerId || this.running.has(conversationId)) return;
      this.nextPrompts.set(conversationId, { after: answerId, text });
      this.ctx.bus.publish({ type: 'chat.updated', conversationId });
    } catch {
      /* no suggestion this time */
    }
  }

  /** Saves a message's images in the conversation's upload folder (after checking them). */
  private saveImages(conversationId: string, messageId: string, images: ChatImageInput[] | undefined): StoredAttachment[] | null {
    const decoded = decodeImages(images);
    if (!decoded.length) return null;
    const dir = path.join(this.ctx.paths.uploads, conversationId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return decoded.map(({ input, bytes }, i) => {
      const file = `${messageId}-${i + 1}.${IMAGE_EXT[input.mediaType]}`;
      writeFileSync(path.join(dir, file), bytes, { mode: 0o600 });
      return { id: newId('img'), name: input.name.replace(/[^\w .-]+/g, '').trim().slice(0, 80) || `image-${i + 1}`, mediaType: input.mediaType, size: bytes.length, file };
    });
  }

  private agentImages(conversationId: string, attachments: StoredAttachment[] | null | undefined): AgentImage[] {
    return (attachments ?? []).map((a) => ({ path: path.join(this.ctx.paths.uploads, conversationId, a.file), mediaType: a.mediaType }));
  }

  /** The images attached to the messages an answer is for, in order. */
  private imagesFor(conversationId: string, messageIds: string[]): AgentImage[] {
    if (!messageIds.length) return [];
    const rows = this.ctx.db.select().from(conversationMessages).where(inArray(conversationMessages.id, messageIds)).orderBy(asc(conversationMessages.createdAt)).all();
    return rows.flatMap((m) => this.agentImages(conversationId, m.attachments));
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
      model: row.model,
      effort: row.effort ?? null,
      lastMessage: last ? truncate(last.content.replace(/\s+/g, ' '), 140) : null,
      running,
      lastStatus: lastAgent?.status ?? null,
      steerable: this.steers.has(row.id),
      needsYou: this.approvals.has(row.id) || (!running && !!lastAgent?.blocked?.some((b) => b.allowable && !row.allowedCommands.includes(b.command))),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

const IMAGE_EXT: Record<ChatImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The file's own first bytes must say it is the image type it claims to be. */
function looksLike(type: ChatImageType, b: Buffer): boolean {
  switch (type) {
    case 'image/png':
      return b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG';
    case 'image/jpeg':
      return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/gif':
      return b.toString('latin1', 0, 4) === 'GIF8';
    case 'image/webp':
      return b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
  }
}

/** Checks attached images (type, size, real image bytes) and decodes them. */
function decodeImages(images: ChatImageInput[] | undefined): { input: ChatImageInput; bytes: Buffer }[] {
  if (!images?.length) return [];
  if (images.length > CHAT_IMAGE_LIMITS.maxImages) throw new OrbitError('VALIDATION', `Attach at most ${CHAT_IMAGE_LIMITS.maxImages} images to one message.`);
  return images.map((input) => {
    if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(input.mediaType)) throw new OrbitError('VALIDATION', 'Only PNG, JPEG, GIF and WebP images can be attached.');
    const bytes = Buffer.from(input.data, 'base64');
    if (!bytes.length || bytes.length > CHAT_IMAGE_LIMITS.maxBytes) throw new OrbitError('VALIDATION', 'Each image must be smaller than 5 MB.');
    if (!looksLike(input.mediaType, bytes)) throw new OrbitError('VALIDATION', 'That file is not the image type it claims to be.');
    return { input, bytes };
  });
}

function cleanModel(model: string | null | undefined): string | null {
  const m = model?.trim();
  return m ? m.slice(0, 120) : null;
}

/**
 * A session's own model applies only to the AI it belongs to (a Claude model never goes to
 * Codex). Its own effort applies to either AI: both take the same levels.
 */
function withModel(seat: SeatCandidate, model: string | null, effort: EffortLevel | null = null): SeatCandidate {
  if (seat.provider === 'scripted') return seat;
  const out = effort ? { ...seat, effort } : seat;
  if (!model) return out;
  const forClaude = model.startsWith('claude-');
  if ((seat.provider === 'claude') !== forClaude) return out;
  return { ...out, model };
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
    attachments: (m.attachments ?? []).map((a) => ({ id: a.id, name: a.name, mediaType: a.mediaType, size: a.size, url: `/api/chats/${m.conversationId}/attachments/${a.file}` })),
    durationMs: m.durationMs,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt,
  };
}

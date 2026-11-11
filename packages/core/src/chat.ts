import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ASSISTANT_SYSTEM,
  assistantPrompt,
  cleanNextPrompt,
  compactPrompt,
  NEXT_PROMPT_SYSTEM,
  nextPromptPrompt,
  cursorModelId,
  pastSessionBlock,
  pastSessionsBrief,
  pastSessionsSystem,
  deniedCommandReason,
  isAllowableCommand,
  parseAssistantReply,
  SECURITY_CHAT_SYSTEM,
  securityCheckMessage,
  SESSION_PLAN_SYSTEM,
  SESSION_READONLY_SYSTEM,
  SESSION_SYSTEM,
  sessionPrompt,
  shellContext,
  type AgentImage,
  type AgentRunRequest,
  type AgentRunResult,
  type ApprovalDecision,
  type ApprovalRequest,
  type SteerFn,
  type AssistantProject,
} from '@orbit/agents';
import { asc, desc, eq, inArray, conversationEvents, conversationMessages, conversations, type ConversationMessageRow, type ConversationRow, type MessageUsage, type StoredAttachment } from '@orbit/database';
import {
  CHAT_IMAGE_LIMITS,
  CHAT_IMAGE_TYPES,
  formatDuration,
  MAX_CHAT_MESSAGE,
  newId,
  type EffortLevel,
  OrbitError,
  redactSecrets,
  modelProvider,
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
import { checkpointRef, dropCheckpoints, restoreCheckpoint, takeCheckpoint } from './checkpoints';
import type { GatewayProvider } from './gateways';
import { pastRefs, type PastSessions } from './past-sessions';
import { audit, nowIso, type OrbitContext } from './context';
import type { RepoService } from './repos';
import { forgetResolvedRuntime } from './runtimes';
import { runShellCommand } from './shell';
import { forgetCodexAvailability, planSeat, type SeatCandidate } from './team';
import { repoChanges } from './workspace';

const MAX_MESSAGE = MAX_CHAT_MESSAGE;
const ASK_MAX_TURNS = 40;
/** Effectively no limit for working sessions: a safety net for a process that hangs for a day. */
const SESSION_TIMEOUT_MS = 24 * 60 * 60_000;
/** Long jobs (a batch, a big refactor) take many steps; Claude Code itself has no step limit. */
const SESSION_MAX_TURNS = 2000;

type Provider = ConversationSummaryDTO['provider'];

/** What a session agent gets of your sessions outside Orbit (see `PastSessions`). */
interface PastContext {
  /** The library folder: readable, never writable. */
  dir: string;
  system: string;
  /** Your latest sessions in the project's folder, for the first message. */
  brief: string;
}

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
  /** Sessions whose current answer is a /compact summary (read-only; it replaces the agent's context). */
  private readonly compacting = new Set<string>();
  /** Projects the active run may write, independent of settings chosen for the next run. */
  private readonly writingProjects = new Map<string, string[]>();
  /** What the agent must be told on its next message (for example that you rewound its file changes). */
  private readonly pendingNotes = new Map<string, string>();

  constructor(
    private readonly ctx: OrbitContext,
    private readonly repos: RepoService,
    private readonly past: PastSessions | null = null,
    /** OpenRouter and your Hugging Face endpoints: AIs that run in Claude Code's tools with their own key. */
    private readonly gateways: GatewayProvider[] = [],
  ) {}

  /** The gateway a session's AI choice means (OpenRouter, Hugging Face), or null for Claude, Codex and Auto. */
  private gatewayFor(provider: string): GatewayProvider | null {
    return this.gateways.find((g) => g.id === provider) ?? null;
  }

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
      messages: msgs.map((m) => toMessageDTO(m, row.compactFrom)),
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
      audit(this.ctx, {
        actor: 'user',
        action: 'session.permission_mode',
        target: id,
        summary: `Working session mode: ${patch.permissionMode === 'auto' ? 'auto-accept (safety-checked)' : patch.permissionMode === 'plan' ? 'plan (read-only until you approve)' : 'ask first'}`,
      });
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
    const row = this.row(id);
    this.dropApprovals(id);
    this.running.get(id)?.abort();
    // Its saved copies of the project's files (for /rewind) go too.
    if (row.repoIds[0]) {
      try {
        void dropCheckpoints(this.ctx.git, this.repos.getRow(row.repoIds[0]).localPath, id);
      } catch {
        /* the project is no longer connected */
      }
    }
    this.compacting.delete(id);
    this.pendingNotes.delete(id);
    this.ctx.db.delete(conversations).where(eq(conversations.id, id)).run();
    rmSync(path.join(this.ctx.paths.uploads, id), { recursive: true, force: true });
    rmSync(path.join(this.ctx.paths.home, 'cursor-sessions', id), { recursive: true, force: true });
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
    return [...this.writingProjects.values()].some((ids) => ids.includes(repoId));
  }

  /**
   * /compact: the agent writes its own summary of the session, and from the next message on its
   * context starts from that summary instead of the whole conversation (frees its context window,
   * like Claude Code's /compact). Works the same for Claude and Codex.
   */
  compact(id: string, focus = ''): ConversationDetailDTO {
    this.row(id);
    if (this.running.has(id)) throw new OrbitError('CONFLICT', 'Wait for the agent to finish (or stop it), then compact.');
    if (!this.messages(id).some((m) => m.role === 'assistant' && m.status === 'done' && m.runtime !== 'shell')) {
      throw new OrbitError('PRECONDITION', 'There is nothing to compact yet: send a message first.');
    }
    const note = focus.trim().slice(0, 500);
    this.compacting.add(id);
    this.ask(id, note ? `/compact ${note}` : '/compact', compactPrompt(note));
    return this.detail(id);
  }

  /**
   * /rewind: go back to just before one of your messages. `code` puts the project's files back as
   * they were then (from the copy Orbit saved before that message was handled); `conversation`
   * removes that message and everything after it, and the agent re-reads the conversation so far.
   * Commits the agent made stay. Returns your message, so it can go back into the prompt.
   */
  async rewind(id: string, input: { messageId: string; code: boolean; conversation: boolean }): Promise<{ chat: ConversationDetailDTO; message: string }> {
    const row = this.row(id);
    if (this.running.has(id)) throw new OrbitError('CONFLICT', 'Stop the agent first, then rewind.');
    if (!input.code && !input.conversation) throw new OrbitError('VALIDATION', 'Choose what to rewind: the code, the conversation, or both.');
    const msgs = this.messages(id);
    const at = msgs.findIndex((m) => m.id === input.messageId && m.role === 'user');
    if (at < 0) throw new OrbitError('NOT_FOUND', 'Message not found.');
    const target = msgs[at]!;
    if (input.code) {
      if (row.mode !== 'edit') throw new OrbitError('PRECONDITION', 'Only working sessions change files.');
      if (!target.checkpoint) throw new OrbitError('PRECONDITION', 'Orbit has no saved copy of the files from before this message.');
      const repo = this.repos.getRow(row.repoIds[0]!);
      if (!repo.allowModify) throw new OrbitError('FORBIDDEN', `${repo.name} is read-only in Orbit.`);
      if (this.isEditing(repo.id)) throw new OrbitError('CONFLICT', 'Another session is still changing this project. Stop it first, then rewind.');
      const res = await restoreCheckpoint(this.ctx.git, repo.localPath, target.checkpoint).catch((err: Error) => {
        throw new OrbitError('CONFLICT', `Could not restore the files: ${redactSecrets(err.message).slice(0, 300)}`);
      });
      audit(this.ctx, { actor: 'user', action: 'session.rewind_code', target: id, summary: `Rewound ${repo.name} to before: ${truncate(target.content, 120)}`, details: { restored: res.restored, removed: res.removed.length } });
      this.ctx.bus.publish({ type: 'repo.changed', repoId: repo.id });
    }
    if (input.conversation) {
      const drop = msgs.slice(at).map((m) => m.id);
      this.ctx.db.delete(conversationEvents).where(inArray(conversationEvents.messageId, drop)).run();
      this.ctx.db.delete(conversationMessages).where(inArray(conversationMessages.id, drop)).run();
      // The agent's own session still remembers the removed messages: it starts a fresh one from what is left.
      this.ctx.db
        .update(conversations)
        .set({ agentSessionId: null, ...(row.compactFrom && drop.includes(row.compactFrom) ? { compactFrom: null } : {}) })
        .where(eq(conversations.id, id))
        .run();
      this.nextPrompts.delete(id);
      this.pendingNotes.delete(id);
      audit(this.ctx, { actor: 'user', action: 'session.rewind_conversation', target: id, summary: `Rewound a session to before: ${truncate(target.content, 120)}`, details: { removed: drop.length } });
    } else {
      this.pendingNotes.set(id, `The developer rewound your file changes to how the project was just before their message "${truncate(target.content.replace(/\s+/g, ' '), 120)}". Whatever you changed after that point is undone: do not assume it is still there.\n\n`);
    }
    this.touch(id);
    return { chat: this.detail(id), message: target.content };
  }

  /**
   * `!command` in the prompt, like Claude Code's bash mode: runs the command in the project right
   * now, shows its output in the session, and tells the agent about it with your next message.
   * Without a session yet, one is created to hold it. Returns at once; the output arrives when done.
   */
  shell(input: { repoId: string; command: string; chatId?: string | null }): ConversationDetailDTO {
    const repo = this.repos.getRow(input.repoId);
    if (!repo.allowModify) throw new OrbitError('FORBIDDEN', `${repo.name} is read-only in Orbit.`, { hint: 'Allow changes for it in Projects, or run the command in a terminal.' });
    const command = input.command.replace(/^\s*!\s*/, '').trim();
    if (!command) throw new OrbitError('VALIDATION', 'Type a command after the ! first.');
    let id = input.chatId ?? null;
    if (id) {
      const row = this.row(id);
      if (!row.repoIds.includes(repo.id)) throw new OrbitError('VALIDATION', 'This session belongs to another project.');
      if (this.running.has(id)) throw new OrbitError('CONFLICT', 'The agent is working. Wait for it, or press Esc to stop it, then run your command.');
    } else {
      id = newId('chat');
      const ts = nowIso(this.ctx);
      this.ctx.db
        .insert(conversations)
        .values({ id, title: titleFrom(`!${command}`), repoIds: [repo.id], mode: repo.allowModify && repo.isGit ? 'edit' : 'ask', provider: 'auto', permissionMode: this.ctx.settings.get().execution.sessionCommands, allowedCommands: [], createdAt: ts, updatedAt: ts })
        .run();
    }
    const chatId = id;
    const ts = nowIso(this.ctx);
    const outId = newId('msg');
    this.ctx.db.insert(conversationMessages).values({ id: newId('msg'), conversationId: chatId, role: 'user', content: `!${command}`, status: 'done', createdAt: ts, finishedAt: ts }).run();
    this.ctx.db.insert(conversationMessages).values({ id: outId, conversationId: chatId, role: 'assistant', content: '', status: 'running', runtime: 'shell', createdAt: nowIso(this.ctx) }).run();
    audit(this.ctx, { actor: 'user', action: 'session.shell', target: repo.id, summary: `Ran a command from the prompt in ${repo.name}: ${truncate(redactSecrets(command), 200)}` });
    this.nextPrompts.delete(chatId);
    this.touch(chatId);
    const controller = new AbortController();
    this.running.set(chatId, controller);
    this.writingProjects.set(chatId, [repo.id]);
    void runShellCommand(this.ctx, repo.localPath, command, controller.signal)
      .then((res) => {
        const status = res.cancelled ? 'cancelled' : res.exitCode === 0 ? 'done' : 'failed';
        const error = res.cancelled ? 'Stopped.' : res.timedOut ? 'Stopped after 2 minutes.' : res.exitCode === 0 ? undefined : `Exit code ${res.exitCode ?? '?'}`;
        this.finish(outId, { status, content: res.output, ...(error ? { error } : {}), durationMs: res.durationMs });
      })
      .catch((err: Error) => this.finish(outId, { status: 'failed', content: '', error: redactSecrets(err.message) }))
      .finally(() => {
        this.running.delete(chatId);
        this.writingProjects.delete(chatId);
        this.afterRun(chatId);
      });
    return this.detail(chatId);
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
    const conv = this.row(conversationId);
    if (conv.mode === 'edit' && conv.permissionMode !== 'plan' && !this.compacting.has(conversationId)) this.writingProjects.set(conversationId, conv.repoIds);
    void this.answer(conversationId, answerId, text, controller.signal, userIds)
      .catch((err: Error) => {
        this.finish(answerId, { status: 'failed', error: redactSecrets(err.message) });
      })
      .finally(() => {
        this.running.delete(conversationId);
        this.writingProjects.delete(conversationId);
        this.compacting.delete(conversationId);
        this.afterRun(conversationId);
      });
  }

  /** After an agent turn or a `!` command: tell the dashboard, and send what was queued meanwhile. */
  private afterRun(conversationId: string): void {
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
  }

  /** The agent's own summary from the last /compact, if the session has one. */
  private compactSummary(conversationId: string): string | null {
    const from = this.row(conversationId).compactFrom;
    if (!from) return null;
    return this.ctx.db.select().from(conversationMessages).where(eq(conversationMessages.id, from)).get()?.content.trim() || null;
  }

  /** Commands you ran with `!` since the agent last answered, newest last. */
  private shellSinceLastAnswer(msgs: ConversationMessageRow[], currentId: string): { command: string; output: string; exitCode: number | null }[] {
    const runs: { command: string; output: string; exitCode: number | null }[] = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role !== 'assistant' || m.id === currentId) continue;
      if (m.runtime !== 'shell') break;
      const asked = msgs[i - 1];
      if (m.status === 'running' || asked?.role !== 'user') continue;
      const code = /^Exit code (\d+)/.exec(m.error ?? '')?.[1];
      runs.unshift({ command: asked.content.replace(/^!/, ''), output: m.content, exitCode: code ? Number(code) : null });
    }
    return runs;
  }

  private async answer(conversationId: string, messageId: string, message: string, signal: AbortSignal, userIds: string[]): Promise<void> {
    const conv = this.row(conversationId);
    const projects = this.projectsFor(conv.repoIds);
    if (!projects.length) {
      this.finish(messageId, { status: 'failed', error: 'This project is no longer connected. Add it again in Projects.' });
      return;
    }
    // OpenRouter or your Hugging Face endpoint: that AI only, never another one in its place. A
    // sleeping endpoint wakes first, and the session says so while it waits.
    const gw = conv.seat !== 'security' ? this.gatewayFor(conv.provider) : null;
    const plan = gw
      ? { primary: (await gw.seat(conv.model, { signal, onProgress: (title) => this.event(conversationId, messageId, { kind: 'note', actor: 'system', title, data: null }) })).candidate, fallback: null }
      : await planSeat(this.ctx, conv.seat === 'security' ? 'security' : 'assistant', conv.provider === 'claude' || conv.provider === 'codex' ? conv.provider : 'auto');
    if (signal.aborted) {
      this.finish(messageId, { status: 'cancelled' });
      return;
    }
    if (!plan.primary || !plan.primary.availability.available) {
      this.finish(messageId, {
        status: 'failed',
        error: plan.primary ? `${plan.primary.runtime.displayName} is not ready: ${plan.primary.availability.reason ?? 'unavailable'}` : 'No AI is connected. Sign in to Claude Code (run `claude`) or Codex (run `codex login`).',
      });
      return;
    }
    const all = this.messages(conversationId);
    const compacting = this.compacting.has(conversationId);
    // After /compact the agent's context starts from its own summary: only later messages travel as history.
    const compactAt = conv.compactFrom ? all.findIndex((m) => m.id === conv.compactFrom) : -1;
    // The messages being answered travel in the prompt itself, not in the history.
    const history = all
      .slice(compactAt + 1)
      .filter((m) => (m.status === 'done' || m.status === 'steered') && m.id !== messageId && !userIds.includes(m.id))
      .map((m) => ({ role: m.role, content: m.content }));
    // Read-only conversations have no summary slot in their prompt: it leads their history instead.
    const summary = compactAt >= 0 ? (all[compactAt]?.content.trim() ?? '') : '';
    if (conv.mode === 'ask' && summary) history.unshift({ role: 'assistant', content: `[Summary of the earlier conversation] ${summary}` });
    // What you did yourself since the agent last answered (`!` commands, a rewind) is told to it with this message.
    const note = this.pendingNotes.get(conversationId) ?? '';
    this.pendingNotes.delete(conversationId);
    const past = await this.pastContext(conv, projects, signal);
    const told = `${shellContext(this.shellSinceLastAnswer(all, messageId))}${note}${past ? this.pastReferences(conversationId, messageId, message) : ''}${message}`;

    // Before an agent that may change files starts, save them, so /rewind can bring them back.
    const repo = projects[0];
    if (conv.mode === 'edit' && conv.permissionMode !== 'plan' && !compacting && repo?.isGit && userIds[0] && !signal.aborted) {
      const saved = await takeCheckpoint(this.ctx.git, repo.localPath, checkpointRef(conversationId, userIds[0]));
      if (saved) this.ctx.db.update(conversationMessages).set({ checkpoint: saved }).where(eq(conversationMessages.id, userIds[0])).run();
    }

    const images = this.imagesFor(conversationId, userIds);
    let result = await this.turn(conv, messageId, withModel(plan.primary, conv.model, conv.effort), projects, told, history, signal, images, past);
    if (result.status === 'rate_limited' && plan.fallback) {
      this.event(conversationId, messageId, { kind: 'note', actor: 'system', title: `${plan.primary.label} hit its usage limit. Switching to ${plan.fallback.label}.`, detail: result.error, data: null });
      result = await this.turn(this.row(conversationId), messageId, withModel(plan.fallback, conv.model, conv.effort), projects, told, history, signal, images, past);
    }

    const blocked = this.blockedFrom(result, this.row(conversationId));
    const usage = usageOf(result);
    if (result.status === 'succeeded') {
      if (conv.mode === 'ask') {
        const parsed = parseAssistantReply(result.text);
        this.finish(messageId, { status: 'done', content: parsed.answer || '(Finished without a written answer.)', suggestion: this.suggestion(parsed.mission, projects), blocked, durationMs: result.durationMs, ...(usage ? { usage } : {}) });
      } else {
        this.finish(messageId, { status: 'done', content: result.text.trim() || (blocked.length ? 'I need your OK to run a command.' : 'Done.'), blocked, durationMs: result.durationMs, ...(usage ? { usage } : {}) });
      }
      if (compacting && result.text.trim()) {
        // From here on the agent's context is this summary, not the conversation: its own session ends.
        this.ctx.db.update(conversations).set({ compactFrom: messageId, agentSessionId: null }).where(eq(conversations.id, conversationId)).run();
      }
      if (conv.seat !== 'security' && !compacting && this.ctx.settings.get().execution.suggestNext) void this.suggestNext(conversationId, messageId);
    } else if (result.status === 'cancelled') {
      this.finish(messageId, { status: 'cancelled', content: result.text ? parseAssistantReply(result.text).answer : '', blocked, durationMs: result.durationMs, ...(usage ? { usage } : {}) });
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
      this.finish(messageId, { status: 'failed', content: result.text ? result.text.trim() : '', error: truncate(redactSecrets(why), 2000), blocked, durationMs: result.durationMs, ...(usage ? { usage } : {}) });
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
    past: PastContext | null,
  ): Promise<AgentRunResult> {
    // A gateway model keeps its own agent session: another model cannot continue one it did not write.
    const runtimeKey = seat.gateway ? `${seat.runtime.id}:${seat.model}` : seat.runtime.id;
    const resumeId = seat.runtime.resumable && conv.agentRuntime === runtimeKey ? conv.agentSessionId : null;
    let result = await this.runOnce(conv, messageId, seat, projects, message, history, resumeId, signal, images, past);
    // A session can disappear (cleared by the CLI, another machine): start fresh with the history instead.
    if (resumeId && result.status === 'failed' && !result.numTurns && !signal.aborted) {
      this.event(conv.id, messageId, { kind: 'note', actor: 'system', title: 'Could not continue the previous session, so the agent starts a fresh one with the conversation so far.', detail: result.error, data: null });
      result = await this.runOnce(conv, messageId, seat, projects, message, history, null, signal, images, past);
    }
    if (seat.runtime.resumable && result.sessionId) {
      this.ctx.db.update(conversations).set({ agentSessionId: result.sessionId, agentRuntime: runtimeKey }).where(eq(conversations.id, conv.id)).run();
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
    past: PastContext | null,
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
    // Plan mode and /compact only read: the agent researches and proposes (or summarizes), and changes nothing.
    const compacting = this.compacting.has(conv.id);
    const readOnlyEdit = edit && (conv.permissionMode === 'plan' || compacting);
    const writes = edit && !readOnlyEdit;
    // Your sessions outside Orbit: a read-only folder, and a note on how to use it.
    const pastRoots = past ? [past.dir] : [];
    const withPast = (system: string) => (past ? `${system}\n\n${past.system}` : system);
    const sessionBase = {
      ...base,
      prompt: sessionPrompt({ message, project: briefs[0]!, history: intro ? history : [], summary: intro ? this.compactSummary(conv.id) : null, intro, ...(past?.brief ? { pastSessions: past.brief } : {}) }),
      readRoots: pastRoots,
    };
    const request: AgentRunRequest = readOnlyEdit
      ? {
          ...sessionBase,
          systemAppend: withPast(compacting ? SESSION_READONLY_SYSTEM : SESSION_PLAN_SYSTEM),
          access: 'read-only',
          maxTurns: compacting ? ASK_MAX_TURNS : SESSION_MAX_TURNS,
          execution: { mode: 'trusted-local', allowNetworkTools: !compacting && settings.execution.allowAgentNetwork },
        }
      : writes
        ? {
          ...sessionBase,
          systemAppend: withPast(SESSION_SYSTEM),
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
          prompt: intro ? assistantPrompt({ question: message, history, projects: briefs, ...(past?.brief ? { pastSessions: past.brief } : {}) }) : message,
          systemAppend: withPast(projects.length === 1 ? `${SESSION_READONLY_SYSTEM}\n\n${ASSISTANT_SYSTEM}` : ASSISTANT_SYSTEM),
          readRoots: [...others.map((r) => r.localPath), ...pastRoots],
          access: 'read-only',
          maxTurns: ASK_MAX_TURNS,
          execution: { mode: 'trusted-local', allowNetworkTools: false },
        };

    // OpenRouter or your Hugging Face endpoint: Claude Code runs the model with that AI's key, never your Claude login.
    if (seat.gateway) {
      const gateway = seat.gateway;
      const gw = this.gateways.find((g) => g.id === modelProvider(seat.model ?? ''));
      const info = gw && seat.model ? gw.info(seat.model) : { name: gateway.model, instructions: '' };
      request.gateway = gateway;
      request.model = gateway.model;
      if (!gateway.tools) request.systemAppend = `${request.systemAppend}\n\n${TOOLLESS_NOTE}`;
      request.systemAppend = `${request.systemAppend}\n\n${identityNote(info.name, gateway.model, gw?.servedBy ?? `served through ${gateway.name}`)}`;
      // Your own master prompt for this model, from the Agents page.
      if (info.instructions) request.systemAppend = `${request.systemAppend}\n\n## The developer's instructions for you (${gateway.model})\nFollow these in every answer, together with the rules above:\n${info.instructions}`;
    }

    // Cursor: its own CLI on your Cursor subscription, with a settings folder for this session alone
    // (the commands you allowed here, Orbit's deny list, and its chats so it can continue them).
    if (seat.runtime.id === 'cursor-cli') {
      request.stateDir = path.join(this.ctx.paths.home, 'cursor-sessions', conv.id);
      request.model = cursorModelId(seat.model);
      const own = seat.model ? this.gatewayFor('cursor')?.info(seat.model).instructions : '';
      if (own) request.systemAppend = `${request.systemAppend}\n\n## The developer's instructions for you (${request.model})\nFollow these in every answer, together with the rules above:\n${own}`;
    }

    const runId = newId('run');
    this.ctx.db.update(conversationMessages).set({ runtime: seat.runtime.id, model: seat.model, kind: readOnlyEdit && !compacting ? 'plan' : 'chat' }).where(eq(conversationMessages.id, messageId)).run();
    const who = edit ? 'Agent' : conv.seat === 'security' ? 'Security reviewer' : 'Assistant';
    const on = request.gateway ? `${request.gateway.model} via ${request.gateway.name}${request.gateway.tools ? '' : ', chat only'}` : `${seat.label}${seat.model ? ` · ${seat.model}` : ''}`;
    this.event(conv.id, messageId, {
      kind: 'agent',
      actor: 'assistant',
      title: `${who} ${resumeId ? 'continued' : 'started'} (${on})`,
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
      ...(writes ? { onApproval: (a: ApprovalRequest) => this.requestApproval(conv.id, messageId, runId, a) } : {}),
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
   * Your sessions outside Orbit, for this answer: null when they are off in Settings, for a
   * security check, or when there are none. Brings the library up to date first (briefly).
   */
  private async pastContext(conv: ConversationRow, projects: RepoDTO[], signal: AbortSignal): Promise<PastContext | null> {
    if (!this.past || conv.seat === 'security' || !this.ctx.settings.get().execution.pastSessions) return null;
    try {
      await this.past.ready();
      if (signal.aborted) return null;
      const folder = projects.length === 1 ? projects[0]!.localPath : null;
      const recent = folder ? this.past.list({ cwd: folder, folderOnly: true, limit: 6 }) : [];
      if (!recent.length && !this.past.list({ limit: 1 }).length) return null;
      return {
        dir: this.past.library,
        system: pastSessionsSystem(this.past.library),
        brief: pastSessionsBrief(recent.map((s) => ({ title: s.title, tool: s.source === 'claude' ? 'Claude Code' : 'Codex', when: (s.updatedAt ?? s.startedAt ?? '').slice(0, 10) || 'unknown date', file: s.file, ref: s.ref }))),
      };
    } catch {
      return null;
    }
  }

  /** `@past:claude/1a2b3c4d` in your message: those sessions' transcripts go with it. */
  private pastReferences(conversationId: string, messageId: string, message: string): string {
    if (!this.past) return '';
    const blocks: string[] = [];
    for (const ref of pastRefs(message)) {
      const hit = this.past.resolve(ref);
      if (!hit) {
        this.event(conversationId, messageId, { kind: 'note', actor: 'system', title: `Could not find the session @past:${ref}. It may have been deleted, or it is one of Orbit's own runs.`, data: null });
        continue;
      }
      const s = hit.session;
      const tool = s.source === 'claude' ? 'Claude Code' : 'Codex';
      this.event(conversationId, messageId, { kind: 'note', actor: 'system', title: `Gave the agent your ${tool} session "${truncate(s.title, 80)}"`, data: { pastSession: s.ref } });
      blocks.push(pastSessionBlock({ title: s.title, tool, cwd: s.cwd, when: (s.updatedAt ?? s.startedAt ?? '').slice(0, 10) || 'unknown date', ref: s.ref, file: hit.file, transcript: hit.transcript }));
    }
    return blocks.join('');
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
      const conv = this.row(conversationId);
      const cwd = this.projectsFor(conv.repoIds)[0]?.localPath;
      // An OpenRouter or Hugging Face session stays on it: its own model guesses, never Claude or
      // Codex. A sleeping endpoint is not woken just for a suggestion.
      const gw = this.gatewayFor(conv.provider);
      const viaOpenRouter = gw ? await gw.seat(conv.model, { wake: false }) : null;
      // Cursor's CLI takes too long to start for a one-line guess, and no other AI may stand in.
      if (viaOpenRouter && !viaOpenRouter.gateway) return;
      const plan = viaOpenRouter ? null : await planSeat(this.ctx, 'prompter');
      const seat = viaOpenRouter ? viaOpenRouter.candidate : [plan?.primary, plan?.fallback].find((s) => s?.availability.available && s.runtime.kind === 'ai');
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
          model: viaOpenRouter?.gateway ? viaOpenRouter.gateway.model : seat.provider === 'claude' ? 'haiku' : seat.model,
          effort: viaOpenRouter ? null : 'low',
          outputSchema: null,
          execution: { mode: 'trusted-local', allowNetworkTools: false },
          // One line of text needs no tools.
          ...(viaOpenRouter?.gateway ? { gateway: { ...viaOpenRouter.gateway, tools: false } } : {}),
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
    if (conv.mode !== 'edit' || conv.permissionMode === 'plan') return [];
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

  private finish(messageId: string, patch: { status: ChatMessageDTO['status']; content?: string; error?: string; suggestion?: MissionSuggestion | null; blocked?: BlockedCommand[]; durationMs?: number; usage?: MessageUsage }): void {
    this.ctx.db
      .update(conversationMessages)
      .set({
        status: patch.status,
        ...(patch.content !== undefined ? { content: redactSecrets(patch.content) } : {}),
        error: patch.error ?? null,
        suggestion: patch.suggestion ?? null,
        blocked: patch.blocked?.length ? patch.blocked : null,
        usage: patch.usage ?? null,
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
    // A command you ran yourself with `!` is not the agent's answer, even when it failed.
    const lastAgent = [...msgs].reverse().find((m) => m.role === 'assistant' && m.runtime !== 'shell');
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

/**
 * Claude Code's own system prompt tells the model it is Claude Code, made by Anthropic. An
 * OpenRouter model is not: it should know, and say so when asked.
 */
function identityNote(name: string, slug: string, servedBy: string): string {
  const shown = name.replace(/^[^:]+:\s*/, '');
  return `Who you are: you are ${shown} (${slug}), a model ${servedBy}. You work inside Orbit, which uses Claude Code's tools as your workbench, but you are not Claude, not Claude Code and not made by Anthropic, whatever earlier parts of this prompt say. If you are asked who or what you are, say that you are ${shown}.`;
}

/** For an OpenRouter model that cannot use tools: it should say so instead of pretending to look. */
const TOOLLESS_NOTE = `In this session you have no tools: you cannot read files, run commands or change anything. Answer from the conversation and what the developer pastes. When you would need to see a file or run something, say exactly what the developer should paste or run, or suggest switching to a model that can use tools.`;

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
  // A model only goes to the AI it belongs to: never a Claude model to Codex, never an OpenRouter
  // model to Claude (OpenRouter sessions pick theirs in `openRouterPlan`).
  if (modelProvider(model) !== seat.provider) return out;
  return { ...out, model };
}

function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length > 70 ? `${line.slice(0, 67).trimEnd()}…` : line;
}

/** What an answer used, for /cost and /context; undefined when the runtime reported nothing. */
function usageOf(r: AgentRunResult): MessageUsage | undefined {
  if (!r.usage && r.costUsd == null && !r.context) return undefined;
  return {
    costUsd: r.costUsd,
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    cacheReadTokens: r.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: r.usage?.cacheWriteTokens ?? 0,
    contextTokens: r.context?.tokens ?? null,
    contextWindow: r.context?.window ?? null,
  };
}

function toMessageDTO(m: ConversationMessageRow, compactFrom: string | null): ChatMessageDTO {
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
    kind: m.runtime === 'shell' ? 'shell' : m.id === compactFrom ? 'summary' : m.kind,
    usage: m.usage ?? null,
    checkpoint: !!m.checkpoint,
    durationMs: m.durationMs,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt,
  };
}

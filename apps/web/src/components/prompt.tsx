import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  CHAT_IMAGE_LIMITS,
  EFFORT_INFO,
  EFFORT_LEVELS,
  type ChatImageInput,
  type ChatMessageDTO,
  type ConversationDetailDTO,
  type ConversationSummaryDTO,
  type PluginActionDTO,
  type PluginDTO,
  type EffortLevel,
  type RepoDTO,
  type SessionMode,
  type SessionPermissionMode,
  type TaskImprovementDTO,
  type TeamDTO,
} from '@orbit/shared';
import { api, keys, post, useAction, useAgents, useChats, usePastSessions, useSkills, useTeam } from '../lib/api';
import { expandPastes, imageToken, insertAt, pasteToken, readImage, shouldFold, usedImages, type AttachedImage, type PastedText } from '../lib/paste';
import { pastHint, pastToken } from '../lib/past';
import { tabs, type WorkspaceTab } from '../lib/tabs';
import { applyMention, contextLines, costLines, mentionAt, rewindTargets } from '../lib/usage';
import { timeAgo } from '../lib/utils';
import { modelLabel } from './provider';

/*
  What a session prompt can do, in both looks (Terminal and Light): slash commands and
  their pickers, Shift+Tab to change mode, Esc to stop, Ctrl+Enter to interrupt and send,
  ↑ for your last message, `?` for shortcuts, pasted or dropped images (`[Image #1]`), long
  pastes folded to `[Pasted text #1 +42 lines]`, and the Prompt engineer's Improve.
  The looks only differ in how they draw it.
*/

export type Provider = ConversationSummaryDTO['provider'];
/** Claude Code's Shift+Tab cycle, in Orbit's terms. */
export type PromptMode = 'ask-first' | 'auto' | 'plan' | 'read-only';
export type MenuKind = 'model' | 'effort' | 'ai' | 'mode' | 'resume' | 'past' | 'delete' | 'skills' | 'skill-install' | 'rewind' | 'rewind-what';

export const promptMode = (mode: SessionMode, perm: SessionPermissionMode): PromptMode => (mode === 'ask' ? 'read-only' : perm === 'auto' ? 'auto' : perm === 'plan' ? 'plan' : 'ask-first');
/** Shift+Tab, as in Claude Code: ask first, auto-accept, plan, and Orbit's read-only. */
export const nextMode = (m: PromptMode, canEdit: boolean): PromptMode => (!canEdit ? 'read-only' : m === 'ask-first' ? 'auto' : m === 'auto' ? 'plan' : m === 'plan' ? 'read-only' : 'ask-first');
export function modePatch(m: PromptMode): { mode: SessionMode; permissionMode?: SessionPermissionMode } {
  return m === 'read-only' ? { mode: 'ask' } : { mode: 'edit', permissionMode: m === 'auto' ? 'auto' : m === 'plan' ? 'plan' : 'ask' };
}

export const MODE_CHOICES: { mode: PromptMode; label: string; hint: string }[] = [
  { mode: 'ask-first', label: 'Ask first', hint: 'edits files, asks before running commands' },
  { mode: 'auto', label: 'Auto-accept', hint: 'runs commands on its own; risky ones are still blocked' },
  { mode: 'plan', label: 'Plan', hint: 'researches and proposes a plan, changes nothing until you approve it' },
  { mode: 'read-only', label: 'Read-only', hint: 'reads and answers, never changes anything' },
];

/** What /init asks for: the agent knows which file its own tool reads. */
export const INIT_PROMPT =
  'Look through this project and write its instructions file for AI coding agents at the project root: CLAUDE.md if you are Claude Code, AGENTS.md if you are Codex. Cover what the project is, how to install, build, test and run it, its structure and conventions, and anything a newcomer would get wrong. Base it on what is really in the code, keep it short and specific to this project, and if the file already exists, improve it instead of replacing it.';

export interface Choice {
  label: ReactNode;
  hint?: ReactNode;
  current?: boolean;
  run: () => void;
}

/** A question with numbered answers: a picker, a permission prompt or a confirmation. */
export interface PromptMenu {
  key: string;
  tone: 'perm' | 'warn' | 'menu';
  title: ReactNode;
  body?: ReactNode;
  question?: ReactNode;
  options: Choice[];
  onCancel: () => void;
  footer?: ReactNode;
}

export interface PromptCommands {
  /** A new session here; `draft` goes into its prompt. */
  clear: (draft?: string) => void;
  open: (sessionId: string) => void;
  changes?: () => void;
  commit?: (message: string) => void;
  security?: () => void;
  close?: () => void;
  expand?: () => void;
  remove?: () => void;
  /** /compact: the agent summarizes the session and continues from that summary. */
  compact?: (focus: string) => void;
  /** /rewind: go back to before one of your messages (the project's files, the conversation, or both). */
  rewind?: (messageId: string, what: { code: boolean; conversation: boolean }) => void;
}

export function improvedText(r: TaskImprovementDTO): string {
  const parts = [r.description.trim()];
  if (r.acceptanceCriteria.length) parts.push(`Done when:\n${r.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`);
  if (r.openQuestions.length) parts.push(`Open questions:\n${r.openQuestions.map((c) => `- ${c}`).join('\n')}`);
  return parts.filter(Boolean).join('\n\n');
}

export type SessionAi = 'claude' | 'codex' | 'openrouter' | 'huggingface' | 'cursor';

/** OpenRouter is ready to pick (an Orbit server from before OpenRouter support sends nothing). */
export const openRouterReady = (team: TeamDTO | undefined) => !!team?.openrouter?.connected;
/** Cursor is ready to pick: the Cursor CLI is installed and signed in. */
export const cursorReady = (team: TeamDTO | undefined) => !!team?.cursor?.ready;
/** Hugging Face is ready to pick: connected, with at least one endpoint Orbit can run sessions on. */
export const huggingFaceReady = (team: TeamDTO | undefined) => !!team?.huggingface?.connected && !!team.huggingface.endpoints?.some((e) => e.usable);

const HF_STATE: Record<string, string> = { running: 'awake', scaledToZero: 'asleep, wakes when used', paused: 'paused', initializing: 'starting', pending: 'starting', updating: 'updating', failed: 'failed', updateFailed: 'failed' };

/** The models each AI offers, and only its own: Claude's, Codex's, or the OpenRouter models you added. */
export function modelChoices(team: TeamDTO | undefined, ai: SessionAi): { id: string; label: string; hint?: string }[] {
  if (ai === 'cursor') return (team?.cursor?.models ?? []).filter((m) => !m.missing).map((m) => ({ id: m.id, label: m.label, hint: m.slug }));
  if (ai === 'huggingface') {
    return (team?.huggingface?.endpoints ?? [])
      .filter((e) => e.usable)
      .map((e) => ({ id: e.id, label: e.name, hint: `${e.repository.split('/').pop()}${e.file ? ` · ${e.file.match(/(I?Q\d+_[A-Z0-9]+(?:_[A-Z])?|BF16|F16)/i)?.[1] ?? ''}` : ''} · ${HF_STATE[e.state] ?? e.state}${e.hardware.pricePerHour != null ? ` · $${e.hardware.pricePerHour}/hour awake` : ''}` }));
  }
  if (ai !== 'openrouter') return team?.providers.find((p) => p.provider === ai)?.models ?? [];
  return (team?.openrouter?.models ?? [])
    .filter((m) => !m.missing)
    .map((m) => ({ id: m.id, label: m.name.replace(/^[^:]+:\s*/, ''), hint: `${m.slug}${m.tools === false ? ' · chat only, cannot read or change files' : ''}` }));
}

/** The session agent's models and defaults, for the AI that will answer. */
export function useAiChoices(provider: Provider) {
  const team = useTeam();
  const agents = useAgents();
  const seat = agents.data?.find((a) => a.role === 'assistant');
  const ai: SessionAi = provider === 'auto' ? (seat?.resolved.provider === 'codex' ? 'codex' : 'claude') : provider;
  const providers = team.data?.providers ?? [];
  const models = modelChoices(team.data, ai);
  // OpenRouter's default is the first model you added there.
  const fallback = (ai === 'openrouter' || ai === 'huggingface' || ai === 'cursor' ? models[0]?.id : ai === 'codex' ? seat?.codexModel : seat?.model) ?? null;
  const name = (m: string | null | undefined) => (m ? (models.find((x) => x.id === m)?.label ?? modelLabel(m) ?? m).replace(/^Claude /, '') : null);
  return { ai, providers, models, fallback, name, effortDefault: seat?.effort ?? null, autoAi: seat?.resolved.provider === 'codex' ? 'Codex' : 'Claude', openrouter: team.data?.openrouter ?? null, huggingface: team.data?.huggingface ?? null, cursor: team.data?.cursor ?? null };
}

/** Arrow keys, Enter, Esc and 1–9 on a numbered menu. */
export function useMenuKeys(menu: PromptMenu, autoFocus: boolean) {
  const first = Math.max(0, menu.options.findIndex((o) => o.current));
  const [sel, setSel] = useState(first);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSel(first);
    if (autoFocus) box.current?.focus({ preventScroll: true });
    // A new menu (by key) starts at its current option.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu.key]);
  const count = menu.options.length;
  const pick = (i: number) => menu.options[i]?.run();
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      setSel((s) => (s + 1) % count);
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      setSel((s) => (s - 1 + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      menu.onCancel();
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= count) {
      e.preventDefault();
      pick(Number(e.key) - 1);
    }
  };
  return { sel, setSel, box, pick, onKeyDown };
}

export interface Slash {
  name: string;
  aliases?: string[];
  hint: string;
  run: (args: string) => void;
}

export interface PromptOptions {
  repo: RepoDTO;
  sessionId: string | null;
  canEdit: boolean;
  /** A security check: read-only, and the AI, model and mode stay as they are. */
  security: boolean;
  value: string;
  onChange: (v: string) => void;
  mode: PromptMode;
  onMode: (m: PromptMode) => void;
  provider: Provider;
  onProvider: (p: Provider) => void;
  model: string | null;
  onModel: (m: string | null) => void;
  effort: EffortLevel | null;
  onEffort: (e: EffortLevel | null) => void;
  running: boolean;
  sending: boolean;
  /** `done` clears the prompt once the message is on its way. */
  onSubmit: (text: string, images: ChatImageInput[], now: boolean, done: () => void) => void;
  onStop?: () => void;
  commands: PromptCommands;
  /** Your earlier messages, newest first (↑ brings back the last one). */
  history: string[];
  menu: MenuKind | null;
  setMenu: (m: MenuKind | null) => void;
  maxHeight?: number;
  /** Your likely next message (after an answer): shown greyed out, Tab takes it. */
  suggestion?: string | null;
  /** This session's messages, for /cost, /context and /rewind. */
  messages?: ChatMessageDTO[];
  /** `!command`: run it in the project now (only where Orbit may change the project). */
  onShell?: (command: string, done: () => void) => void;
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const compactCount = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n));

export function usePrompt(o: PromptOptions) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const chats = useChats();
  // /skills: search Claude Code's marketplaces and install without leaving the session.
  const [skillQuery, setSkillQuery] = useState('');
  const [picked, setPicked] = useState<PluginDTO | null>(null);
  const skillResults = useSkills(skillQuery, 'all', 9, o.menu === 'skills');
  const installSkill = useAction((id: string) => post<PluginActionDTO>('/api/skills/install', { id }), { invalidate: [['skills'], ['skill-details']] });
  const choices = useAiChoices(o.provider);
  const [slashSel, setSlashSel] = useState(0);
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Longer, neutral answers (/cost, /context): shown under the prompt until you type. */
  const [info, setInfo] = useState<string[] | null>(null);
  const [rewindId, setRewindId] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [fileSel, setFileSel] = useState(0);
  /** The `@` position whose suggestions you closed with Esc. */
  const [mentionOff, setMentionOff] = useState<number | null>(null);
  const [proposal, setProposal] = useState<TaskImprovementDTO | null>(null);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [pastes, setPastes] = useState<PastedText[]>([]);
  const [dragging, setDragging] = useState(false);
  const counter = useRef({ image: 0, paste: 0 });
  // In an OpenRouter session, Improve runs on its OpenRouter model too, never on Claude or Codex.
  const improve = useAction((text: string) => post<TaskImprovementDTO>('/api/prompts/improve', { text, repoId: o.repo.id, ...(o.provider === 'openrouter' || o.provider === 'huggingface' || o.provider === 'cursor' ? { gateway: { provider: o.provider, model: o.model } } : {}) }), {});
  // /past and /resume: your Claude Code and Codex sessions from outside Orbit.
  const [pastQuery, setPastQuery] = useState('');
  const pastSearch = o.menu === 'past' ? pastQuery : '';
  const past = usePastSessions(pastSearch, o.repo.id, (o.menu === 'past' || o.menu === 'resume') && !o.security);

  // `@` completes the project's files and folders, like Claude Code's file mentions.
  const mention = mentionAt(o.value, caret);
  const mentionQuery = mention && mention.start !== mentionOff ? mention.query : null;
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (mentionQuery == null) return;
    const t = setTimeout(() => setTyped(mentionQuery), 120);
    return () => clearTimeout(t);
  }, [mentionQuery]);
  const fileResults = useQuery({
    queryKey: ['files', o.repo.id, typed],
    queryFn: () => api<string[]>(`/api/repos/${o.repo.id}/files?q=${encodeURIComponent(typed)}`),
    enabled: mentionQuery != null && !mentionQuery.startsWith('past:') && o.repo.isGit && !o.security,
    staleTime: 10_000,
    placeholderData: (previous) => previous,
  });
  const files = mentionQuery != null && !o.security ? (fileResults.data ?? []).slice(0, 8) : [];
  const fileIndex = Math.min(fileSel, Math.max(0, files.length - 1));
  const pickFile = (path: string) => {
    if (!mention) return;
    const r = applyMention(o.value, caret, mention, path);
    o.onChange(r.value);
    setCaret(r.caret);
    setFileSel(0);
    // A folder keeps suggesting what is inside it.
    setMentionOff(null);
    requestAnimationFrame(() => {
      ref.current?.focus({ preventScroll: true });
      ref.current?.setSelectionRange(r.caret, r.caret);
    });
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, o.maxHeight ?? 280)}px`;
  }, [o.value, o.maxHeight]);

  const focus = () => requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
  const closeMenu = () => {
    o.setMenu(null);
    focus();
  };

  /** Puts a token where the cursor is, as if it had been typed. */
  const insert = (token: string) => {
    const el = ref.current;
    const v = el ? el.value : o.value;
    const r = insertAt(v, el?.selectionStart ?? v.length, el?.selectionEnd ?? v.length, token);
    o.onChange(r.value);
    requestAnimationFrame(() => {
      el?.focus({ preventScroll: true });
      el?.setSelectionRange(r.caret, r.caret);
    });
  };

  const addImages = async (files: File[]) => {
    const room = CHAT_IMAGE_LIMITS.maxImages - images.length;
    if (files.length > room) setNotice(`A message can carry ${CHAT_IMAGE_LIMITS.maxImages} images at most.`);
    for (const f of files.slice(0, Math.max(0, room))) {
      try {
        const img = await readImage(f, f.name || 'pasted image');
        const n = ++counter.current.image;
        setImages((prev) => [...prev, { ...img, n }]);
        insert(imageToken(n));
      } catch (err) {
        setNotice((err as Error).message);
      }
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      void addImages(files);
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (text && shouldFold(text)) {
      e.preventDefault();
      const p = { n: ++counter.current.paste, text };
      setPastes((prev) => [...prev, p]);
      insert(pasteToken(p));
    }
  };

  const dropProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent<HTMLElement>) => {
      setDragging(false);
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        void addImages(files);
      }
    },
  };

  const removeImage = (n: number) => {
    setImages((prev) => prev.filter((i) => i.n !== n));
    o.onChange(o.value.split(imageToken(n)).join('').replace(/ {2,}/g, ' '));
  };

  const improveText = (args: string) => {
    const text = expandPastes(args.trim() || o.value.trim(), pastes);
    if (!text) {
      setNotice('Type /improve followed by your request, or write it first.');
      return;
    }
    improve.mutate(text, { onSuccess: setProposal });
  };

  const setModelByName = (q: string) => {
    const want = q.toLowerCase();
    const hit = choices.models.find((m) => m.id.toLowerCase() === want || m.label.toLowerCase().includes(want));
    if (hit) o.onModel(hit.id);
    else o.setMenu('model');
  };

  const { commands } = o;
  const messages = o.messages ?? [];
  const targets = rewindTargets(messages);
  const canWrite = o.canEdit && !o.security;
  const slashes: Slash[] = [
    { name: 'model', hint: 'Choose the model for this session', run: (a) => (a ? setModelByName(a) : o.setMenu('model')) },
    {
      name: 'effort',
      hint: 'How hard the agent thinks, low to max',
      run: (a) => {
        const level = EFFORT_LEVELS.find((l) => l === a.toLowerCase());
        if (level) o.onEffort(level);
        else o.setMenu('effort');
      },
    },
    {
      name: 'ai',
      hint: 'Use Claude, Codex or Auto',
      run: (a) => {
        const p = (['auto', 'claude', 'codex', 'openrouter', 'huggingface', 'cursor'] as const).find((x) => x === a.toLowerCase().replace(/[\s-]/g, ''));
        if (p) o.onProvider(p);
        else o.setMenu('ai');
      },
    },
    ...(!o.security ? [{ name: 'mode', hint: 'Ask first, auto-accept, plan or read-only (shift+tab)', run: () => o.setMenu('mode') }] : []),
    ...(canWrite ? [{ name: 'plan', hint: 'Plan mode: research and propose, change nothing until you approve', run: () => o.onMode('plan') }] : []),
    ...(canWrite
      ? [
          {
            name: 'init',
            hint: 'Have the agent write the project instructions file (CLAUDE.md or AGENTS.md)',
            run: () => {
              if (o.mode === 'read-only' || o.mode === 'plan') setNotice(`Switch to Ask first or Auto-accept (shift+tab) so the agent may write the file, then run /init again.`);
              else o.onSubmit(INIT_PROMPT, [], false, () => undefined);
            },
          },
        ]
      : []),
    ...(o.sessionId && commands.compact && !o.security
      ? [{ name: 'compact', hint: 'Summarize the session so the agent continues with a fresh context: /compact <focus>', run: (a: string) => (o.running ? setNotice('The agent is working. Wait for it, or press esc, then compact.') : commands.compact!(a)) }]
      : []),
    { name: 'cost', aliases: ['usage'], hint: 'What this session has used', run: () => setInfo(costLines(messages)) },
    { name: 'context', hint: 'How full the context window is', run: () => setInfo(contextLines(messages)) },
    ...(o.sessionId && commands.rewind && canWrite
      ? [
          {
            name: 'rewind',
            aliases: ['undo', 'checkpoint'],
            hint: 'Go back to before one of your messages (restores the files too)',
            run: () => (o.running ? setNotice('The agent is working. Press esc to stop it, then rewind.') : targets.length ? o.setMenu('rewind') : setNotice('There is nothing to rewind to yet.')),
          },
        ]
      : []),
    { name: 'resume', hint: 'Open another session of this project, or continue one you had in Claude Code or Codex', run: () => o.setMenu('resume') },
    ...(!o.security
      ? [
          {
            name: 'past',
            aliases: ['history', 'sessions'],
            hint: 'Give the agent one of your Claude Code or Codex sessions, from any folder: /past <search>',
            run: (a: string) => {
              setPastQuery(a.trim());
              o.setMenu('past');
            },
          },
        ]
      : []),
    {
      name: 'skills',
      aliases: ['plugin', 'plugins'],
      hint: 'Find and install skills: /skills <search>',
      run: (a) => {
        setSkillQuery(a.trim());
        o.setMenu('skills');
      },
    },
    { name: 'clear', aliases: ['new'], hint: 'Start a new session here', run: () => commands.clear() },
    ...(commands.changes ? [{ name: 'changes', aliases: ['diff'], hint: 'See what changed, commit or check security', run: () => commands.changes!() }] : []),
    ...(commands.commit ? [{ name: 'commit', hint: 'Commit the changes: /commit <message>', run: (a: string) => commands.commit!(a) }] : []),
    ...(commands.security ? [{ name: 'security', hint: 'Check the uncommitted changes for security problems', run: () => commands.security!() }] : []),
    { name: 'improve', hint: 'Let the prompt engineer improve a request: /improve <text>', run: improveText },
    ...(o.running && o.onStop ? [{ name: 'stop', hint: 'Interrupt the agent (esc)', run: () => o.onStop!() }] : []),
    ...(commands.expand ? [{ name: 'full', hint: 'Show this session full size', run: () => commands.expand!() }] : []),
    ...(commands.remove ? [{ name: 'delete', hint: 'Delete this session', run: () => o.setMenu('delete') }] : []),
    ...(commands.close ? [{ name: 'close', hint: 'Close this tab (the session is kept)', run: () => commands.close!() }] : []),
    { name: 'help', hint: 'Commands and shortcuts', run: () => setHelp(true) },
  ];

  const query = o.value.startsWith('/') && !/\s/.test(o.value) ? o.value.slice(1).toLowerCase() : null;
  const suggestions = query == null ? [] : slashes.filter((c) => c.name.startsWith(query) || c.aliases?.some((a) => a.startsWith(query)));
  const sel = Math.min(slashSel, Math.max(0, suggestions.length - 1));
  // Eight at a time, scrolling with the selection.
  const windowStart = Math.min(Math.max(0, sel - 7), Math.max(0, suggestions.length - 8));

  const runSlash = (c: Slash, args: string) => {
    o.onChange('');
    setHelp(false);
    setSlashSel(0);
    c.run(args);
  };

  const submit = (now: boolean) => {
    const raw = o.value.trim();
    if ((!raw && !images.length) || o.sending) return;
    if (raw.startsWith('!')) {
      const command = raw.slice(1).trim();
      if (!o.onShell) setNotice('Commands with ! run in projects Orbit may change. Open a terminal for this one.');
      else if (!command) setNotice('Type a command after the !, for example !git status.');
      else if (o.running) setNotice('The agent is working. Press esc to stop it, then run your command.');
      else {
        setNotice(null);
        setInfo(null);
        o.onShell(command, () => o.onChange(''));
      }
      return;
    }
    if (raw.startsWith('/')) {
      const head = raw.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
      const c = slashes.find((s) => s.name === head || s.aliases?.includes(head));
      if (c) {
        runSlash(c, raw.slice(1 + head.length).trim());
        return;
      }
    }
    const used = usedImages(raw, images);
    const text = expandPastes(raw, pastes).trim() || used.map((i) => imageToken(i.n)).join(' ');
    if (!text) return;
    setNotice(null);
    o.onSubmit(
      text,
      used.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
      now && o.running,
      () => {
        o.onChange('');
        setImages([]);
        setPastes([]);
        counter.current = { image: 0, paste: 0 };
      },
    );
  };

  // Shown while the prompt is empty and the agent is idle, as Claude Code does.
  const ghost = !o.value && !o.running && o.suggestion ? o.suggestion : null;

  const cycleMode = () => {
    if (!o.security && o.canEdit) o.onMode(nextMode(o.mode, o.canEdit));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (e.key === 'Tab' && !o.value && ghost) {
      e.preventDefault();
      o.onChange(ghost);
      return;
    }
    if (files.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFileSel((fileIndex + 1) % files.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFileSel((fileIndex - 1 + files.length) % files.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        pickFile(files[fileIndex]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOff(mention?.start ?? null);
        return;
      }
    }
    if (suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSel((sel + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSel((sel - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        o.onChange(`/${suggestions[sel]!.name} `);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runSlash(suggestions[sel]!, '');
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (help) setHelp(false);
      else if (o.value.startsWith('/')) o.onChange('');
      else if (o.running && o.onStop) o.onStop();
      return;
    }
    if (e.key === '?' && !o.value) {
      e.preventDefault();
      setHelp((h) => !h);
      return;
    }
    if (e.key === 'ArrowUp' && !o.value && o.history.length) {
      e.preventDefault();
      o.onChange(o.history[0]!);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(e.ctrlKey || e.metaKey);
    }
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    o.onChange(e.target.value);
    setCaret(e.target.selectionStart);
    setSlashSel(0);
    setFileSel(0);
    if (notice) setNotice(null);
    if (info) setInfo(null);
    if (help && e.target.value) setHelp(false);
  };

  // Pickers, numbered as in Claude Code.
  const sessions = (chats.data ?? []).filter((c) => c.repoIds.length === 1 && c.repoIds[0] === o.repo.id);
  const pickerFor = (kind: MenuKind): PromptMenu => {
    switch (kind) {
      case 'model':
        return {
          key: 'model',
          tone: 'menu',
          title: 'Select model',
          body: o.running ? 'Applies to the next run. The current run and messages sent into it keep the original model.' : `For this session only. ${choices.ai === 'openrouter' ? 'The default is the first model in your OpenRouter list' : choices.ai === 'huggingface' ? 'The default is your first Hugging Face endpoint' : choices.ai === 'cursor' ? 'The default is the first model in your Cursor list' : "The default is the session agent's model"} (Agents page).`,
          options: [
            { label: `Default (${choices.name(choices.fallback) ?? 'agent setting'})`, current: !o.model, run: () => (o.onModel(null), closeMenu()) },
            ...choices.models.map((m) => ({ label: m.label.replace(/^Claude /, ''), hint: m.hint ?? m.id, current: o.model === m.id, run: () => (o.onModel(m.id), closeMenu()) })),
          ],
          onCancel: closeMenu,
        };
      case 'effort':
        return {
          key: 'effort',
          tone: 'menu',
          title: 'Select effort',
          body: `Higher effort thinks longer and uses more tokens.${o.running ? ' Applies to the next run; the current run keeps its effort.' : ''}`,
          options: [
            { label: `Default (${choices.effortDefault ? EFFORT_INFO[choices.effortDefault].label : 'agent setting'})`, current: !o.effort, run: () => (o.onEffort(null), closeMenu()) },
            ...EFFORT_LEVELS.map((l) => ({ label: EFFORT_INFO[l].label, hint: EFFORT_INFO[l].description, current: o.effort === l, run: () => (o.onEffort(l), closeMenu()) })),
          ],
          onCancel: closeMenu,
        };
      case 'ai': {
        const status = (p: 'claude' | 'codex') => {
          const s = choices.providers.find((x) => x.provider === p);
          return s ? (s.available ? 'ready' : (s.reason ?? 'not ready')) : '';
        };
        return {
          key: 'ai',
          tone: 'menu',
          title: 'Select AI',
          body: o.running ? 'Applies to the next run. The current AI keeps working until it finishes or you stop it.' : undefined,
          options: [
            { label: 'Auto', hint: `follows your AI team (now ${choices.autoAi})`, current: o.provider === 'auto', run: () => (o.onProvider('auto'), closeMenu()) },
            { label: 'Claude', hint: status('claude'), current: o.provider === 'claude', run: () => (o.onProvider('claude'), closeMenu()) },
            { label: 'Codex', hint: status('codex'), current: o.provider === 'codex', run: () => (o.onProvider('codex'), closeMenu()) },
            choices.openrouter?.connected
              ? { label: 'OpenRouter', hint: 'DeepSeek, Hermes and other models, with your OpenRouter key', current: o.provider === 'openrouter', run: () => (o.onProvider('openrouter'), closeMenu()) }
              : { label: 'OpenRouter', hint: 'not connected: add your key on the Agents page', current: false, run: () => (closeMenu(), navigate('/agents')) },
            choices.huggingface?.connected && choices.huggingface.endpoints?.some((e) => e.usable)
              ? { label: 'Hugging Face', hint: 'your own model on a rented GPU (Inference Endpoints)', current: o.provider === 'huggingface', run: () => (o.onProvider('huggingface'), closeMenu()) }
              : { label: 'Hugging Face', hint: 'create an endpoint on the Agents page first', current: false, run: () => (closeMenu(), navigate('/agents')) },
            choices.cursor?.ready
              ? { label: 'Cursor', hint: 'your Cursor subscription (Claude, GPT, Grok, Composer…)', current: o.provider === 'cursor', run: () => (o.onProvider('cursor'), closeMenu()) }
              : { label: 'Cursor', hint: choices.cursor?.installed ? 'not signed in: type ! cursor-agent login' : 'install the Cursor CLI first (Agents page)', current: false, run: () => (closeMenu(), navigate('/agents')) },
          ],
          onCancel: closeMenu,
        };
      }
      case 'mode':
        return {
          key: 'mode',
          tone: 'menu',
          title: 'Select mode',
          body: o.running ? 'Applies to the next run. Stop the current run first if you need it to stop editing.' : undefined,
          options: MODE_CHOICES.filter((m) => o.canEdit || m.mode === 'read-only').map((m) => ({ label: m.label, hint: m.hint, current: o.mode === m.mode, run: () => (o.onMode(m.mode), closeMenu()) })),
          onCancel: closeMenu,
        };
      case 'resume': {
        // Sessions you had in this folder outside Orbit continue in a new session here.
        const outside = (past.data?.sessions ?? []).filter((s) => s.repoId === o.repo.id).slice(0, 4);
        const own = sessions.slice(0, 9 - Math.min(outside.length, 4) - 1);
        return {
          key: `resume:${outside.length}`,
          tone: 'menu',
          title: `Sessions in ${o.repo.name}`,
          body: outside.length ? 'Sessions from Claude Code or Codex continue in a new session here: the agent gets what was said and done.' : undefined,
          options: [
            { label: 'New session', current: !o.sessionId, run: () => (o.setMenu(null), commands.clear()) },
            ...own.map((c) => ({
              label: c.seat === 'security' ? `Security check: ${c.title}` : c.title,
              hint: `${c.running ? 'working · ' : ''}${timeAgo(c.updatedAt)}`,
              current: c.id === o.sessionId,
              run: () => (o.setMenu(null), commands.open(c.id)),
            })),
            ...outside.map((s) => ({
              label: s.title,
              hint: pastHint(s, { folder: false }),
              run: () => {
                o.setMenu(null);
                const draft = `Continue this session: ${pastToken(s)} `;
                if (o.sessionId) commands.clear(draft);
                else {
                  o.onChange(draft);
                  focus();
                }
              },
            })),
          ],
          onCancel: closeMenu,
        };
      }
      case 'past': {
        const d = past.data;
        const list = (d?.sessions ?? []).slice(0, 9);
        return {
          key: `past:${pastSearch}:${list.map((s) => s.ref).join(',')}:${d?.enabled ?? 'loading'}`,
          tone: 'menu',
          title: pastSearch ? `Your sessions about "${pastSearch}"` : 'Your Claude Code and Codex sessions',
          body: !d
            ? 'Looking through your sessions…'
            : !d.enabled
              ? 'Turned off in Settings → Sessions from Claude Code and Codex.'
              : !list.length
                ? d.indexing
                  ? 'Still reading your sessions for the first time. Try again in a moment.'
                  : pastSearch
                    ? 'No session matches. Try other words: /past <search>'
                    : 'No Claude Code or Codex sessions found on this computer yet.'
                : `Pick one and the agent gets it with your message, from any folder. This project's sessions come first.${pastSearch ? '' : ' Search with /past <words>.'}${d.indexing ? ' Still reading older sessions…' : ''}`,
          options: d && !d.enabled
            ? [{ label: 'Open Settings', run: () => (o.setMenu(null), navigate('/settings')) }, { label: 'Never mind', run: closeMenu }]
            : list.length
              ? list.map((s) => ({
                  label: s.title,
                  hint: pastHint(s),
                  run: () => {
                    o.setMenu(null);
                    insert(`${pastToken(s)} `);
                    setNotice(`The agent gets "${clip(s.title, 60)}" with your message.`);
                  },
                }))
              : [{ label: 'Never mind', run: closeMenu }],
          onCancel: closeMenu,
        };
      }
      case 'skills': {
        const r = skillResults.data;
        return {
          key: `skills:${skillQuery}:${r?.results.length ?? 'loading'}`,
          tone: 'menu',
          title: skillQuery ? `Skills for "${skillQuery}"` : 'Most installed skills',
          body: skillResults.isPending
            ? 'Searching Claude Code\'s marketplaces…'
            : r && !r.available
              ? (r.reason ?? 'Claude Code\'s plugins are not available right now.')
              : r
                ? `${r.total.toLocaleString()} ${r.total === 1 ? 'match' : 'matches'}. Pick one to install it for Claude Code on this computer.`
                : undefined,
          options: [
            ...(r?.results ?? []).map((p) => ({
              label: p.name,
              hint: `${p.marketplaceLabel}${p.installs ? ` · ${compactCount(p.installs)} installs` : ''}${p.description ? ` · ${p.description.slice(0, 70)}${p.description.length > 70 ? '…' : ''}` : ''}`,
              current: p.installed,
              run: () => {
                if (p.installed) {
                  setNotice(`${p.name} is already installed.`);
                  closeMenu();
                } else if (p.needsCommand) {
                  setNotice(`${p.name} installs by running a command: add it in Claude Code with /plugin, where you can review it.`);
                  closeMenu();
                } else {
                  setPicked(p);
                  o.setMenu('skill-install');
                }
              },
            })),
            { label: 'Open the Skills page', hint: 'browse and search everything', run: () => (o.setMenu(null), navigate(skillQuery ? `/skills?q=${encodeURIComponent(skillQuery)}` : '/skills')) },
          ],
          onCancel: closeMenu,
        };
      }
      case 'skill-install': {
        const p = picked;
        return {
          key: `skill-install:${p?.id ?? ''}`,
          tone: 'perm',
          title: p ? `Install ${p.name}?` : 'Install',
          body: p
            ? `${p.description ?? ''}\n\nFrom ${p.marketplaceLabel}${p.installs ? `, ${compactCount(p.installs)} installs` : ''}. It installs for Claude Code on this computer (your terminal too). Plugins can run hooks and MCP servers: install only what you trust.`
            : undefined,
          options: [
            {
              label: installSkill.isPending ? 'Installing…' : 'Install',
              run: () => {
                if (!p || installSkill.isPending) return;
                installSkill.mutate(p.id, {
                  onSuccess: (res) => {
                    setNotice(res.message);
                    setPicked(null);
                    closeMenu();
                  },
                  onError: () => closeMenu(),
                });
              },
            },
            { label: 'Cancel', run: () => (setPicked(null), closeMenu()) },
          ],
          onCancel: () => (setPicked(null), closeMenu()),
        };
      }
      case 'rewind':
        return {
          key: 'rewind',
          tone: 'menu',
          title: 'Rewind to before…',
          body: 'Pick one of your messages. Next you choose what to restore.',
          options: [
            ...targets.slice(0, 9).map((t) => ({ label: clip(t.text, 80), hint: t.checkpoint ? undefined : '(no saved files)', run: () => (setRewindId(t.id), o.setMenu('rewind-what')) })),
            { label: 'Never mind', run: closeMenu },
          ],
          onCancel: closeMenu,
        };
      case 'rewind-what': {
        const t = targets.find((x) => x.id === rewindId);
        const go = (what: { code: boolean; conversation: boolean }) => {
          setRewindId(null);
          o.setMenu(null);
          if (t) commands.rewind?.(t.id, what);
        };
        return {
          key: `rewind-what:${rewindId}`,
          tone: 'warn',
          title: 'Rewind to before this message?',
          body: t ? `"${clip(t.text, 200)}"` : undefined,
          options: [
            ...(t?.checkpoint ? [{ label: 'Restore code and conversation', hint: 'the files go back; this message and everything after it are removed', run: () => go({ code: true, conversation: true }) }] : []),
            { label: 'Restore conversation', hint: 'this message and everything after it are removed; the files stay as they are', run: () => go({ code: false, conversation: true }) },
            ...(t?.checkpoint ? [{ label: 'Restore code', hint: 'the files go back; the conversation stays', run: () => go({ code: true, conversation: false }) }] : []),
            { label: 'Never mind', run: () => (setRewindId(null), closeMenu()) },
          ],
          onCancel: () => (setRewindId(null), closeMenu()),
          footer: 'Commits the agent made stay. Changes you made yourself after that message are lost when the code is restored. Esc to cancel',
        };
      }
      case 'delete':
        return {
          key: 'delete',
          tone: 'warn',
          title: 'Delete this session?',
          body: 'Its messages are removed. Your files stay as they are.',
          options: [
            { label: 'No, keep it', run: closeMenu },
            { label: 'Yes, delete it', run: () => (o.setMenu(null), commands.remove?.()) },
          ],
          onCancel: closeMenu,
        };
    }
  };

  const proposalMenu: PromptMenu | null = proposal
    ? {
        key: 'improve',
        tone: 'perm',
        title: 'The prompt engineer suggests',
        body: proposal.whatChanged ?? undefined,
        question: improvedText(proposal),
        options: [
          { label: 'Use it', run: () => (o.onChange(improvedText(proposal)), setPastes([]), setProposal(null), focus()) },
          { label: 'Keep mine', run: () => (setProposal(null), focus()) },
        ],
        onCancel: () => (setProposal(null), focus()),
      }
    : null;

  const effortNow = o.effort ?? choices.effortDefault;
  return {
    ref,
    focus,
    textarea: { ref, value: o.value, onChange, onKeyDown, onPaste, onSelect: (e: SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart) },
    dropProps,
    dragging,
    images,
    removeImage,
    hasPastes: pastes.length > 0,
    slashes,
    suggestions,
    sel,
    windowStart,
    setSlashSel,
    runSlash,
    help,
    setHelp,
    notice,
    info,
    files,
    fileIndex,
    pickFile,
    setFileSel,
    shellMode: o.value.startsWith('!'),
    improving: improve.isPending,
    improve: () => improveText(''),
    picker: o.menu ? pickerFor(o.menu) : null,
    proposalMenu,
    submit,
    cycleMode,
    ghost,
    openMenu: o.setMenu,
    status: {
      aiText: `${choices.ai === 'codex' ? 'Codex' : choices.ai === 'openrouter' ? 'OpenRouter' : choices.ai === 'huggingface' ? 'Hugging Face' : choices.ai === 'cursor' ? 'Cursor' : 'Claude'}${o.provider === 'auto' ? ' (auto)' : ''}`,
      modelText: choices.name(o.model) ?? choices.name(choices.fallback) ?? 'default model',
      effortText: `${effortNow ? EFFORT_INFO[effortNow].label.toLowerCase() : 'default'} effort`,
    },
  };
}

/** What a tab's next new session starts with (/resume continuing one of your Claude Code or Codex sessions). */
const pendingDrafts = new Map<string, string>();
export function takeDraft(tabKey: string): string {
  const d = pendingDrafts.get(tabKey) ?? '';
  pendingDrafts.delete(tabKey);
  return d;
}

/** Project actions the prompt offers (/commit, /security, /resume, /clear), shared by both looks. */
export function useRepoActions(repo: RepoDTO, tab: WorkspaceTab) {
  const navigate = useNavigate();
  const commit = useAction((message: string) => post<{ sha: string; files: number }>(`/api/repos/${repo.id}/commit`, { message }), {
    success: (r) => `Committed ${r.files} ${r.files === 1 ? 'file' : 'files'} to ${repo.name}`,
    invalidate: [keys.changes(repo.id)],
  });
  const security = useAction(() => post<ConversationDetailDTO>(`/api/repos/${repo.id}/security-check`), { invalidate: [keys.chats] });
  return {
    open: (id: string) => {
      tabs.show(tab.key, id);
      navigate(`/s/${id}`);
    },
    clear: (draft?: string) => {
      if (draft) pendingDrafts.set(tab.key, draft);
      tabs.show(tab.key, null);
      navigate('/');
    },
    commit: (message: string, openPanel: () => void) => (message.trim() ? commit.mutate(message.trim()) : openPanel()),
    security: () =>
      security.mutate(undefined, {
        onSuccess: (c) => {
          tabs.openSession(c.id, repo.id);
          navigate(`/s/${c.id}`);
        },
      }),
  };
}

export type PromptState = ReturnType<typeof usePrompt>;

/** The shortcuts shown by `?` and /help. */
export const SHORTCUTS = ['/ for commands', 'shift+tab to cycle modes', 'esc to interrupt', 'ctrl+enter to interrupt and send', 'shift+enter for a new line', '↑ for your last message', 'ctrl+v to paste an image', '@ to mention a file', '/past for your Claude Code and Codex sessions', '! to run a command yourself'];

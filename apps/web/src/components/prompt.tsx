import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  CHAT_IMAGE_LIMITS,
  EFFORT_INFO,
  EFFORT_LEVELS,
  type ChatImageInput,
  type ConversationDetailDTO,
  type ConversationSummaryDTO,
  type PluginActionDTO,
  type PluginDTO,
  type EffortLevel,
  type RepoDTO,
  type SessionMode,
  type SessionPermissionMode,
  type TaskImprovementDTO,
} from '@orbit/shared';
import { keys, post, useAction, useAgents, useChats, useSkills, useTeam } from '../lib/api';
import { expandPastes, imageToken, insertAt, pasteToken, readImage, shouldFold, usedImages, type AttachedImage, type PastedText } from '../lib/paste';
import { tabs, type WorkspaceTab } from '../lib/tabs';
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
export type PromptMode = 'ask-first' | 'auto' | 'read-only';
export type MenuKind = 'model' | 'effort' | 'ai' | 'mode' | 'resume' | 'delete' | 'skills' | 'skill-install';

export const promptMode = (mode: SessionMode, perm: SessionPermissionMode): PromptMode => (mode === 'ask' ? 'read-only' : perm === 'auto' ? 'auto' : 'ask-first');
export const nextMode = (m: PromptMode, canEdit: boolean): PromptMode => (!canEdit ? 'read-only' : m === 'ask-first' ? 'auto' : m === 'auto' ? 'read-only' : 'ask-first');
export function modePatch(m: PromptMode): { mode: SessionMode; permissionMode?: SessionPermissionMode } {
  return m === 'read-only' ? { mode: 'ask' } : { mode: 'edit', permissionMode: m === 'auto' ? 'auto' : 'ask' };
}

export const MODE_CHOICES: { mode: PromptMode; label: string; hint: string }[] = [
  { mode: 'ask-first', label: 'Ask first', hint: 'edits files, asks before running commands' },
  { mode: 'auto', label: 'Auto-accept', hint: 'runs commands on its own; risky ones are still blocked' },
  { mode: 'read-only', label: 'Read-only', hint: 'reads and answers, never changes anything' },
];

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
  clear: () => void;
  open: (sessionId: string) => void;
  changes?: () => void;
  commit?: (message: string) => void;
  security?: () => void;
  close?: () => void;
  expand?: () => void;
  remove?: () => void;
}

export function improvedText(r: TaskImprovementDTO): string {
  const parts = [r.description.trim()];
  if (r.acceptanceCriteria.length) parts.push(`Done when:\n${r.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`);
  if (r.openQuestions.length) parts.push(`Open questions:\n${r.openQuestions.map((c) => `- ${c}`).join('\n')}`);
  return parts.filter(Boolean).join('\n\n');
}

/** The session agent's models and defaults, for the AI that will answer. */
export function useAiChoices(provider: Provider) {
  const team = useTeam();
  const agents = useAgents();
  const seat = agents.data?.find((a) => a.role === 'assistant');
  const ai: 'claude' | 'codex' = provider === 'auto' ? (seat?.resolved.provider === 'codex' ? 'codex' : 'claude') : provider;
  const providers = team.data?.providers ?? [];
  const models = providers.find((p) => p.provider === ai)?.models ?? [];
  const fallback = (ai === 'codex' ? seat?.codexModel : seat?.model) ?? null;
  const name = (m: string | null | undefined) => (m ? (models.find((x) => x.id === m)?.label ?? modelLabel(m) ?? m).replace(/^Claude /, '') : null);
  return { ai, providers, models, fallback, name, effortDefault: seat?.effort ?? null, autoAi: seat?.resolved.provider === 'codex' ? 'Codex' : 'Claude' };
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
}

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
  const [proposal, setProposal] = useState<TaskImprovementDTO | null>(null);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [pastes, setPastes] = useState<PastedText[]>([]);
  const [dragging, setDragging] = useState(false);
  const counter = useRef({ image: 0, paste: 0 });
  const improve = useAction((text: string) => post<TaskImprovementDTO>('/api/prompts/improve', { text, repoId: o.repo.id }), {});

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
        const p = (['auto', 'claude', 'codex'] as const).find((x) => x === a.toLowerCase());
        if (p) o.onProvider(p);
        else o.setMenu('ai');
      },
    },
    ...(!o.security ? [{ name: 'mode', hint: 'Ask first, auto-accept or read-only (shift+tab)', run: () => o.setMenu('mode') }] : []),
    { name: 'resume', hint: 'Open another session of this project', run: () => o.setMenu('resume') },
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
    setSlashSel(0);
    if (notice) setNotice(null);
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
          body: "For this session only. The default is the session agent's model (Agents page).",
          options: [
            { label: `Default (${choices.name(choices.fallback) ?? 'agent setting'})`, current: !o.model, run: () => (o.onModel(null), closeMenu()) },
            ...choices.models.map((m) => ({ label: m.label.replace(/^Claude /, ''), hint: m.id, current: o.model === m.id, run: () => (o.onModel(m.id), closeMenu()) })),
          ],
          onCancel: closeMenu,
        };
      case 'effort':
        return {
          key: 'effort',
          tone: 'menu',
          title: 'Select effort',
          body: 'Higher effort thinks longer and uses more tokens.',
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
          options: [
            { label: 'Auto', hint: `follows your AI team (now ${choices.autoAi})`, current: o.provider === 'auto', run: () => (o.onProvider('auto'), closeMenu()) },
            { label: 'Claude', hint: status('claude'), current: o.provider === 'claude', run: () => (o.onProvider('claude'), closeMenu()) },
            { label: 'Codex', hint: status('codex'), current: o.provider === 'codex', run: () => (o.onProvider('codex'), closeMenu()) },
          ],
          onCancel: closeMenu,
        };
      }
      case 'mode':
        return {
          key: 'mode',
          tone: 'menu',
          title: 'Select mode',
          options: MODE_CHOICES.filter((m) => o.canEdit || m.mode === 'read-only').map((m) => ({ label: m.label, hint: m.hint, current: o.mode === m.mode, run: () => (o.onMode(m.mode), closeMenu()) })),
          onCancel: closeMenu,
        };
      case 'resume':
        return {
          key: 'resume',
          tone: 'menu',
          title: `Sessions in ${o.repo.name}`,
          options: [
            { label: 'New session', current: !o.sessionId, run: () => (o.setMenu(null), commands.clear()) },
            ...sessions.slice(0, 9).map((c) => ({
              label: c.seat === 'security' ? `Security check: ${c.title}` : c.title,
              hint: `${c.running ? 'working · ' : ''}${timeAgo(c.updatedAt)}`,
              current: c.id === o.sessionId,
              run: () => (o.setMenu(null), commands.open(c.id)),
            })),
          ],
          onCancel: closeMenu,
        };
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
    textarea: { ref, value: o.value, onChange, onKeyDown, onPaste },
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
    improving: improve.isPending,
    improve: () => improveText(''),
    picker: o.menu ? pickerFor(o.menu) : null,
    proposalMenu,
    submit,
    cycleMode,
    openMenu: o.setMenu,
    status: {
      aiText: `${choices.ai === 'codex' ? 'Codex' : 'Claude'}${o.provider === 'auto' ? ' (auto)' : ''}`,
      modelText: choices.name(o.model) ?? choices.name(choices.fallback) ?? 'default model',
      effortText: `${effortNow ? EFFORT_INFO[effortNow].label.toLowerCase() : 'default'} effort`,
    },
  };
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
    clear: () => {
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
export const SHORTCUTS = ['/ for commands', 'shift+tab to cycle modes', 'esc to interrupt', 'ctrl+enter to interrupt and send', 'shift+enter for a new line', '↑ for your last message', 'ctrl+v to paste an image'];

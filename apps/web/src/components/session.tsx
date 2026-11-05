import { AlertTriangle, ArrowUp, Check, ChevronDown, Copy, History, Loader2, Plus, RotateCcw, ShieldCheck, Square, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import type { ChatEventDTO, ChatMessageDTO, ConversationDetailDTO, ConversationSummaryDTO, RepoDTO, SessionMode, SessionPermissionMode, TaskImprovementDTO } from '@orbit/shared';
import { formatDuration } from '@orbit/shared';
import { buildLiveModel, type LiveRun, type LiveStep } from '../lib/live-steps';
import { del, keys, patch, post, useAction, useAgents, useChat, useChats, useSettings } from '../lib/api';
import { tabs, type WorkspaceTab } from '../lib/tabs';
import { cn, timeAgo } from '../lib/utils';
import { ChangesPanel } from './changes-panel';
import { KIND_ICON, Plan, since, useTick } from './live-steps';
import { Markdown } from './markdown';
import { NewMissionDialog } from './new-mission';
import { modelLabel, PROVIDER_NAME, PROVIDER_TEXT, providerOfRuntime } from './provider';
import { Button, ErrorNote, Loading } from './ui';

type Provider = ConversationSummaryDTO['provider'];

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

/** Which AI works in this tab. */
export function ProviderSwitch({ value, onChange, disabled }: { value: Provider; onChange: (p: Provider) => void; disabled?: boolean }) {
  const options: { value: Provider; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
  ];
  return (
    <div className="inline-flex items-center gap-1.5">
    <span className="text-2xs text-dust">AI</span>
    <div className="inline-flex rounded-[10px] bg-hull-2 p-0.5" role="radiogroup" aria-label="Which AI works here">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-xs transition-colors disabled:opacity-50',
            value === o.value ? 'bg-hull font-[600] text-chalk shadow-[0_1px_2px_rgb(16_24_40/0.1)]' : 'text-dust hover:text-chalk',
          )}
        >
          {o.value !== 'auto' ? <span className={cn('size-1.5 rounded-full bg-current', PROVIDER_TEXT[o.value])} aria-hidden /> : null}
          {o.label}
        </button>
      ))}
    </div>
    </div>
  );
}

function ModeSwitch({ value, onChange, canEdit }: { value: SessionMode; onChange: (m: SessionMode) => void; canEdit: boolean }) {
  return (
    <div className="inline-flex rounded-[10px] bg-hull-2 p-0.5" role="radiogroup" aria-label="What the AI may do">
      {(
        [
          { value: 'edit', label: 'Can change files' },
          { value: 'ask', label: 'Only answers questions' },
        ] as const
      ).map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.value === 'edit' && !canEdit}
          title={o.value === 'edit' && !canEdit ? 'This project is read-only in Orbit (change that in Projects).' : undefined}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 rounded-[8px] px-2.5 text-xs transition-colors disabled:opacity-40',
            value === o.value ? 'bg-hull font-[600] text-chalk shadow-[0_1px_2px_rgb(16_24_40/0.1)]' : 'text-dust hover:text-chalk',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** How commands are handled in a working session, like Shift+Tab in Claude Code. */
export function CommandsSwitch({ value, onChange, provider }: { value: SessionPermissionMode; onChange: (m: SessionPermissionMode) => void; provider: Provider }) {
  const codex = provider === 'codex';
  const options: { value: SessionPermissionMode; label: string; hint: string }[] = [
    { value: 'ask', label: 'Ask first', hint: 'The agent asks before running any command that changes things. You click Allow.' },
    {
      value: 'auto',
      label: 'Auto-accept',
      hint: "Commands run on their own, like Claude Code's auto mode. A safety check still blocks risky ones, and agents can never push, commit or read secret files.",
    },
  ];
  return (
    <div className="inline-flex items-center gap-1.5" title={codex ? 'Codex always runs commands inside its own sandbox (no network, no git writes), whichever you pick.' : undefined}>
      <span className="text-2xs text-dust">Commands</span>
      <div className="inline-flex rounded-[10px] bg-hull-2 p-0.5" role="radiogroup" aria-label="How commands are handled">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-7 rounded-[8px] px-2.5 text-xs transition-colors',
              value === o.value ? (o.value === 'auto' ? 'bg-telemetry font-[600] text-hull shadow-[0_1px_2px_rgb(16_24_40/0.15)]' : 'bg-hull font-[600] text-chalk shadow-[0_1px_2px_rgb(16_24_40/0.1)]') : 'text-dust hover:text-chalk',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function aiName(runtime: string | null | undefined, seat?: ConversationSummaryDTO['seat']): { name: string; text: string } {
  if (seat === 'security') return { name: 'Security reviewer', text: 'text-chalk' };
  const p = providerOfRuntime(runtime);
  return { name: p ? (PROVIDER_NAME[p] ?? 'Agent') : 'Agent', text: p ? (PROVIDER_TEXT[p] ?? 'text-chalk') : 'text-chalk' };
}

// ---------------------------------------------------------------------------
// Composer, with the Prompt engineer's "Improve"
// ---------------------------------------------------------------------------

function improvedText(r: TaskImprovementDTO): string {
  const parts = [r.description.trim()];
  if (r.acceptanceCriteria.length) parts.push(`Done when:\n${r.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`);
  if (r.openQuestions.length) parts.push(`Open questions:\n${r.openQuestions.map((c) => `- ${c}`).join('\n')}`);
  return parts.filter(Boolean).join('\n\n');
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  sending,
  placeholder,
  repoId,
  big,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  running: boolean;
  sending: boolean;
  placeholder: string;
  repoId: string;
  big?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [proposal, setProposal] = useState<TaskImprovementDTO | null>(null);
  const improve = useAction((text: string) => post<TaskImprovementDTO>('/api/prompts/improve', { text, repoId }), {});
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (value.trim() && !running && !sending) onSend();
    }
  };
  return (
    <div className="space-y-2">
      {proposal ? (
        <div className="rounded-[14px] border border-telemetry/30 bg-telemetry/[0.05] p-3.5">
          <p className="flex items-center gap-2 text-xs font-[600] text-telemetry">
            <Wand2 className="size-3.5" aria-hidden /> The Prompt engineer suggests
          </p>
          {proposal.whatChanged ? <p className="mt-1 text-xs text-dust">{proposal.whatChanged}</p> : null}
          <pre className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-6 text-chalk">{improvedText(proposal)}</pre>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onChange(improvedText(proposal));
                setProposal(null);
                ref.current?.focus();
              }}
            >
              Use this
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
              Keep mine
            </Button>
          </div>
        </div>
      ) : null}
      <div className={cn('rounded-[16px] border border-seam-2 bg-hull shadow-[0_1px_2px_rgb(16_24_40/0.05)] focus-within:border-telemetry/70 focus-within:shadow-[0_0_0_3px_rgb(11_124_113/0.12)]', big && 'rounded-[18px]')}>
        <textarea
          ref={ref}
          rows={big ? 3 : 1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          aria-label="Your message"
          autoFocus
          className={cn('block max-h-64 w-full resize-none bg-transparent px-4 pt-3 text-chalk outline-none placeholder:text-dust-2', big ? 'min-h-[84px] text-base' : 'min-h-[28px] text-[14.5px]')}
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          <button
            type="button"
            onClick={() => improve.mutate(value, { onSuccess: setProposal })}
            disabled={!value.trim() || improve.isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-xs text-dust transition-colors hover:bg-hull-2 hover:text-chalk disabled:opacity-40"
            title="Let the Prompt engineer turn your message into a clear, complete request"
          >
            {improve.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Wand2 className="size-3.5" aria-hidden />}
            {improve.isPending ? 'Improving…' : 'Improve'}
          </button>
          <span className="flex items-center gap-2">
            <span className="hidden text-2xs text-dust-2 sm:inline">Enter to send, Shift+Enter for a new line</span>
            {running && onStop ? (
              <Button size="sm" onClick={onStop} aria-label="Stop the agent">
                <Square className="size-3 fill-current" /> Stop
              </Button>
            ) : (
              <Button size="icon" variant="primary" onClick={onSend} disabled={!value.trim() || sending || running} aria-label="Send">
                {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              </Button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function StepLine({ step, folder }: { step: LiveStep; folder: string }) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[step.kind];
  const object = folder && step.object.startsWith(`${folder}/`) ? step.object.slice(folder.length + 1) : step.object;
  const verb = step.status === 'running' ? step.verb.doing : step.verb.done;
  const blocked = step.kind === 'blocked';
  return (
    <li className={cn('rounded-[8px] px-2 py-1', step.status === 'running' && 'bg-telemetry/[0.06]', blocked && 'bg-signal/[0.1]')}>
      <div className="flex min-w-0 items-center gap-2 text-[13px] leading-6">
        {step.status === 'running' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-telemetry" aria-label="Working" />
        ) : step.status === 'failed' ? (
          blocked ? <AlertTriangle className="size-3.5 shrink-0 text-signal-deep" aria-hidden /> : <span className="grid size-3.5 shrink-0 place-items-center text-fault" aria-label="Failed">✕</span>
        ) : step.status === 'stopped' ? (
          <span className="size-3.5 shrink-0 text-center text-dust-2" aria-label="Interrupted">–</span>
        ) : (
          <Check className="size-3.5 shrink-0 text-go" aria-label="Done" />
        )}
        <Icon className="size-3.5 shrink-0 text-dust-2" aria-hidden />
        {blocked ? <span className="shrink-0 font-[600] text-signal-deep">Needs your OK</span> : verb ? <span className="shrink-0 text-chalk/80">{verb}</span> : null}
        <span className={cn('mono min-w-0 truncate', blocked ? 'text-chalk' : 'text-dust')} title={step.object}>
          {object}
        </span>
        {step.detail && !blocked ? (
          <button type="button" className="shrink-0 text-2xs text-fault hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'hide' : 'why?'}
          </button>
        ) : null}
      </div>
      {open && step.detail ? <pre className="mono ml-6 mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-[8px] bg-hull-2 p-2 text-[12px] text-dust">{step.detail}</pre> : null}
    </li>
  );
}

const SHOW_LAST = 6;

function AgentTurn({ msg, events, seat, isLast, allowed, onAllow, onAllowAll, onRetry, folder }: {
  folder: string;
  onAllowAll: () => void;
  msg: ChatMessageDTO;
  events: ChatEventDTO[];
  seat: ConversationSummaryDTO['seat'];
  isLast: boolean;
  allowed: string[];
  onAllow: (command: string) => void;
  onRetry: () => void;
}) {
  const running = msg.status === 'running';
  const model = useMemo(() => buildLiveModel(events, running), [events, running]);
  const tick = useTick(running);
  const [showAll, setShowAll] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [mission, setMission] = useState(false);
  const runs = model.blocks.filter((b): b is LiveRun => b.type === 'run');
  const final = msg.content.trim();
  // Interim messages tell the story between steps; the final one is shown as the answer below.
  const items = runs.flatMap((r) => r.steps).filter((s) => !(s.kind === 'say' && (s.detail ?? '').trim() === final) && s.kind !== 'note');
  const toolCount = items.filter((s) => s.kind !== 'say').length;
  const hidden = !showAll && !running && items.length > SHOW_LAST + 2 ? items.length - SHOW_LAST : 0;
  const shown = hidden ? items.slice(hidden) : items;
  const plan = [...runs].reverse().find((r) => r.plan?.length)?.plan ?? null;
  const notes = model.blocks.filter((b) => b.type === 'milestone');
  const who = aiName(msg.runtime, seat);
  const blocked = isLast && !running ? msg.blocked.filter((b) => !dismissed.includes(b.command) && !allowed.includes(b.command)) : [];

  return (
    <div className="group/turn">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn('text-sm font-[650]', who.text)}>{who.name}</span>
        {msg.model ? <span className="text-2xs text-dust">{modelLabel(msg.model)}</span> : null}
        {running ? (
          <span className="text-2xs text-telemetry tabular">working for {since(msg.createdAt, tick)}</span>
        ) : msg.durationMs != null ? (
          <span className="text-2xs text-dust-2 tabular">took {formatDuration(msg.durationMs)}</span>
        ) : null}
      </div>

      {notes.map((n) => (
        <p key={n.key} className="mt-1.5 rounded-[8px] bg-signal/[0.1] px-2.5 py-1.5 text-xs text-signal-deep">
          {n.title}
        </p>
      ))}

      {plan ? (
        <div className="mt-2">
          <Plan items={plan} />
        </div>
      ) : null}

      {items.length || running ? (
        <ol className="mt-2 space-y-0.5 border-l-2 border-seam pl-2.5" aria-label={`What ${who.name} did`}>
          {hidden ? (
            <li>
              <button type="button" onClick={() => setShowAll(true)} className="rounded-[8px] px-2 py-1 text-xs text-dust hover:bg-hull-2 hover:text-chalk">
                Show {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
              </button>
            </li>
          ) : null}
          {shown.map((s) =>
            s.kind === 'say' ? (
              <li key={s.id} className="px-2 py-1 text-sm leading-6 text-chalk/85">
                {s.detail ?? s.object}
              </li>
            ) : (
              <StepLine key={s.id} step={s} folder={folder} />
            ),
          )}
          {running && !items.length ? (
            <li className="flex items-center gap-2 px-2 py-1 text-[13px] text-dust">
              <Loader2 className="size-3.5 animate-spin text-telemetry" aria-hidden /> Getting ready…
            </li>
          ) : null}
        </ol>
      ) : null}

      {final ? <Markdown text={final} className="mt-3" /> : null}
      {!running && !final && msg.status === 'done' && toolCount ? <p className="mt-2 text-sm text-dust">Done.</p> : null}
      {msg.status === 'cancelled' ? <p className="mt-2 text-xs text-dust">You stopped it here.</p> : null}

      {msg.status === 'failed' ? (
        <div className="mt-3 flex flex-wrap items-start gap-3 rounded-[12px] border border-fault/30 bg-fault/[0.05] px-3.5 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-fault" aria-hidden />
          <p className="min-w-0 flex-1 text-chalk">{msg.error ?? 'Something went wrong.'}</p>
          {isLast ? (
            <Button size="sm" onClick={onRetry}>
              <RotateCcw className="size-3.5" /> Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {blocked.map((b) => (
        <div key={b.command} className="mt-3 rounded-[14px] border border-signal/60 bg-signal/[0.09] p-3.5">
          <p className="text-sm font-[650] text-chalk">{who.name} wants to run a command</p>
          <pre className="mono mt-2 overflow-x-auto whitespace-pre-wrap rounded-[8px] bg-hull px-3 py-2 text-[13px] text-chalk">{b.command}</pre>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {b.allowable ? (
              <Button size="sm" variant="primary" onClick={() => onAllow(b.command)}>
                Allow and continue
              </Button>
            ) : null}
            <Button size="sm" onClick={onAllowAll} title="Switch this session to Auto-accept: commands run on their own, a safety check still blocks risky ones">
              Allow everything in this session
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissed([...dismissed, b.command])}>
              Not now
            </Button>
            {!b.allowable ? (
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(b.command)}>
                <Copy className="size-3.5" /> Copy
              </Button>
            ) : null}
          </div>
          <p className="mt-2 text-2xs text-dust">
            {b.allowable ? 'Allowed commands run without asking again in this session. ' : 'This one is too long to allow on its own. '}
            Allowing everything works like Claude Code's auto mode: a safety check still blocks risky commands.
          </p>
        </div>
      ))}

      {msg.suggestion ? (
        <div className="mt-3 rounded-[14px] border border-seam bg-hull-2/60 p-3.5">
          <p className="text-sm font-[650]">Hand this to Autopilot?</p>
          <p className="mt-1 text-sm text-chalk/85">{msg.suggestion.title}</p>
          <p className="mt-1 text-xs text-dust">The planner, engineer and reviewers take it from here in a separate copy of the project, and wait for your approval.</p>
          <Button size="sm" className="mt-3" onClick={() => setMission(true)}>
            Start in Autopilot
          </Button>
          {mission ? <NewMissionDialog key={msg.id} open={mission} onOpenChange={setMission} initial={msg.suggestion} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function Transcript({ chat, folder, onAllow, onAllowAll, onRetry }: { chat: ConversationDetailDTO; folder: string; onAllow: (c: string) => void; onAllowAll: () => void; onRetry: (q: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  const byMessage = useMemo(() => {
    const map = new Map<string, ChatEventDTO[]>();
    for (const e of chat.events) map.set(e.messageId, [...(map.get(e.messageId) ?? []), e]);
    return map;
  }, [chat.events]);
  const lastAgent = [...chat.messages].reverse().find((m) => m.role === 'assistant')?.id;

  useEffect(() => {
    const el = box.current;
    if (el && near.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length, chat.events.length, chat.messages.at(-1)?.status]);

  return (
    <div
      ref={box}
      onScroll={() => {
        const el = box.current;
        if (el) near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8"
    >
      <div className="mx-auto max-w-[760px] space-y-7">
        {chat.messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-[18px] rounded-br-[6px] bg-hull-3 px-4 py-2.5 text-[14.5px] leading-6 text-chalk">{m.content}</div>
            </div>
          ) : (
            <AgentTurn
              key={m.id}
              msg={m}
              events={byMessage.get(m.id) ?? []}
              seat={chat.seat}
              isLast={m.id === lastAgent}
              allowed={chat.allowedCommands}
              onAllow={onAllow}
              onAllowAll={onAllowAll}
              folder={folder}
              onRetry={() => {
                const q = [...chat.messages.slice(0, i)].reverse().find((x) => x.role === 'user');
                if (q) onRetry(q.content);
              }}
            />
          ),
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session header: project, AI, mode, other sessions
// ---------------------------------------------------------------------------

function SessionsMenu({ repo, tab, current }: { repo: RepoDTO; tab: WorkspaceTab; current: string | null }) {
  const chats = useChats();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const mine = (chats.data ?? []).filter((c) => c.repoIds.length === 1 && c.repoIds[0] === repo.id);
  return (
    <div ref={box} className="relative">
      <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
        <History className="size-3.5" /> Sessions
        <ChevronDown className="size-3" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-10 z-30 w-80 rounded-[12px] border border-seam bg-hull p-1.5 shadow-[0_12px_32px_-12px_rgb(16_24_40/0.25)]">
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2.5 text-sm font-[600] hover:bg-hull-2"
            onClick={() => {
              tabs.newSession(repo.id);
              setOpen(false);
            }}
          >
            <Plus className="size-4" /> New session in {repo.name}
          </button>
          {mine.length ? <div className="my-1 h-px bg-seam" /> : null}
          <ul className="max-h-72 overflow-y-auto">
            {mine.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    tabs.show(tab.key, c.id);
                    setOpen(false);
                  }}
                  className={cn('block w-full rounded-[8px] px-2.5 py-2 text-left hover:bg-hull-2', c.id === current && 'bg-hull-2')}
                >
                  <span className="flex items-center gap-2 text-sm">
                    {c.running ? <span className="size-1.5 shrink-0 rounded-full bg-telemetry" aria-label="Working" /> : null}
                    {c.seat === 'security' ? <ShieldCheck className="size-3.5 shrink-0 text-dust" aria-hidden /> : null}
                    <span className="truncate">{c.title}</span>
                  </span>
                  <span className="block text-2xs text-dust-2">{timeAgo(c.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Header({
  repo,
  tab,
  chat,
  provider,
  onProvider,
  children,
  trailing,
}: {
  repo: RepoDTO;
  tab: WorkspaceTab;
  chat: ConversationDetailDTO | null;
  provider: Provider;
  onProvider: (p: Provider) => void;
  children?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-seam px-5 py-3">
      <div className="w-full min-w-0 sm:w-auto sm:flex-1">
        <h2 className="casual truncate text-lg font-[700] leading-6">{chat?.seat === 'security' ? `Security check of ${repo.name}` : repo.name}</h2>
        <p className="mono truncate text-2xs text-dust" title={repo.localPath}>
          {repo.localPath}
        </p>
      </div>
      {children}
      {chat?.seat !== 'security' ? <ProviderSwitch value={provider} onChange={onProvider} /> : null}
      <SessionsMenu repo={repo} tab={tab} current={chat?.id ?? null} />
      {trailing}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A tab: a new session, or a running one
// ---------------------------------------------------------------------------

const STARTERS = [
  { label: 'Explain this project', text: 'Give me a short tour of this project: what it does, how it is organised, and where the important code lives.' },
  { label: 'Find and fix a bug', text: 'Look for the most likely bug in this project, explain it, and fix it with a test.' },
  { label: 'Add missing tests', text: 'Find important logic that has no tests and add focused tests for it.' },
  { label: 'Polish the UI', text: 'Review the user interface of this project and improve the weakest screen, keeping the existing style. Use the design skill that fits this project.' },
];

function NewSession({ repo, tab }: { repo: RepoDTO; tab: WorkspaceTab }) {
  const navigate = useNavigate();
  const canEdit = repo.allowModify && repo.isGit;
  const agents = useAgents();
  const settings = useSettings();
  const [draft, setDraft] = useState('');
  const [provider, setProvider] = useState<Provider>('auto');
  const [mode, setMode] = useState<SessionMode>(canEdit ? 'edit' : 'ask');
  const [commands, setCommands] = useState<SessionPermissionMode | null>(null);
  const permissionMode = commands ?? settings.data?.execution.sessionCommands ?? 'ask';
  const start = useAction((message: string) => post<ConversationDetailDTO>('/api/chats', { message, repoIds: [repo.id], mode, provider, permissionMode }), { invalidate: [keys.chats] });
  const seat = agents.data?.find((a) => a.role === 'assistant');
  const autoName = seat?.resolved.provider ? PROVIDER_NAME[seat.resolved.provider] : 'the AI';
  const who = provider === 'auto' ? autoName : PROVIDER_NAME[provider];
  const send = (text = draft) =>
    text.trim() &&
    start.mutate(text.trim(), {
      onSuccess: (c) => {
        tabs.attach(tab.key, c.id);
        setDraft('');
        navigate(`/s/${c.id}`);
      },
    });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header repo={repo} tab={tab} chat={null} provider={provider} onProvider={setProvider} />
      <div className="flex flex-1 flex-col justify-center overflow-y-auto px-5 py-10">
        <div className="mx-auto w-full max-w-[680px]">
          <h1 className="text-[28px] leading-9">What should we do in {repo.name}?</h1>
          <p className="mt-2 text-sm text-dust">
            {mode === 'edit'
              ? `${who} works directly in this project, like Claude Code in a terminal: it reads, edits files and asks before running commands. You review the changes and commit.`
              : `${who} reads this project and answers. Nothing is changed.`}
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
            <ModeSwitch value={mode} onChange={setMode} canEdit={canEdit} />
            {mode === 'edit' ? <CommandsSwitch value={permissionMode} onChange={setCommands} provider={provider} /> : null}
          </div>
          <div className="mt-3">
            <Composer value={draft} onChange={setDraft} onSend={() => send()} running={false} sending={start.isPending} placeholder={mode === 'edit' ? `Tell ${who} what to change…` : `Ask ${who} about ${repo.name}…`} repoId={repo.id} big />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {STARTERS.filter((s) => mode === 'edit' || s.label === 'Explain this project').map((s) => (
              <button key={s.label} type="button" onClick={() => setDraft(s.text)} className="rounded-full border border-seam bg-hull px-3 py-1.5 text-xs text-chalk/85 transition-colors hover:border-seam-2 hover:bg-hull-2">
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunningSession({ repo, tab, sessionId }: { repo: RepoDTO; tab: WorkspaceTab; sessionId: string }) {
  const navigate = useNavigate();
  const chat = useChat(sessionId);
  const [draft, setDraft] = useState('');
  const [showChanges, setShowChanges] = useState(false);
  const invalidate = [keys.chats, keys.chat(sessionId)];
  const send = useAction((message: string) => post<ConversationDetailDTO>(`/api/chats/${sessionId}/messages`, { message }), { invalidate });
  const stop = useAction(() => post(`/api/chats/${sessionId}/cancel`), { invalidate });
  const setProvider = useAction((provider: Provider) => patch(`/api/chats/${sessionId}`, { provider }), { invalidate });
  const allow = useAction((command: string) => post<ConversationDetailDTO>(`/api/chats/${sessionId}/allow`, { command }), { invalidate });
  const allowAll = useAction(() => post<ConversationDetailDTO>(`/api/chats/${sessionId}/allow-all`), { invalidate });
  const setCommands = useAction((permissionMode: SessionPermissionMode) => patch(`/api/chats/${sessionId}`, { permissionMode }), {
    success: (r) => ((r as ConversationSummaryDTO).permissionMode === 'auto' ? 'Auto-accept on: commands run on their own, risky ones are still blocked' : 'Ask first: the agent asks before running commands'),
    invalidate,
  });
  const remove = useAction(() => del(`/api/chats/${sessionId}`), { success: 'Session deleted', invalidate: [keys.chats] });
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (chat.isPending) return <Loading label="Opening the session" />;
  if (chat.error || !chat.data) return <div className="p-6"><ErrorNote error={chat.error} /></div>;
  const c = chat.data;
  const running = c.messages.some((m) => m.status === 'running');
  const editing = c.mode === 'edit';
  const editEvents = c.events.filter((e) => e.kind === 'tool' && (e.data as { step?: string } | null)?.step === 'edit').length;
  const who = c.provider === 'auto' ? 'the agent' : PROVIDER_NAME[c.provider];
  const submit = (text = draft) => text.trim() && send.mutate(text.trim(), { onSuccess: () => setDraft('') });

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col bg-hull">
        <Header
          repo={repo}
          tab={tab}
          chat={c}
          provider={c.provider}
          onProvider={(p) => setProvider.mutate(p)}
          trailing={
            confirmDelete ? (
            <span className="flex items-center gap-1.5 text-xs">
              Delete this session?
              <Button
                size="sm"
                variant="danger"
                loading={remove.isPending}
                onClick={() =>
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      tabs.close(tab.key);
                      navigate('/');
                    },
                  })
                }
              >
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button size="icon" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete this session" title="Delete this session">
              <Trash2 className="size-4" />
            </Button>
          )
          }
        >
          {editing ? <CommandsSwitch value={c.permissionMode} onChange={(m) => setCommands.mutate(m)} provider={c.provider} /> : null}
          {editing ? (
            <Button size="sm" variant="ghost" className="xl:hidden" onClick={() => setShowChanges(!showChanges)} aria-expanded={showChanges}>
              Changes
            </Button>
          ) : (
            <span className="rounded-full bg-hull-2 px-2.5 py-1 text-2xs text-dust">{c.seat === 'security' ? 'Read-only check' : 'Only answers questions'}</span>
          )}
        </Header>
        <Transcript
          chat={c}
          folder={repo.localPath.split(/[\\/]/).filter(Boolean).pop() ?? ''}
          onAllow={(cmd) => allow.mutate(cmd)}
          onAllowAll={() => allowAll.mutate(undefined)}
          onRetry={(q) => submit(q)}
        />
        <div className="border-t border-seam bg-hull px-5 py-3 sm:px-8">
          <div className="mx-auto max-w-[760px]">
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={() => submit()}
              onStop={() => stop.mutate(undefined)}
              running={running}
              sending={send.isPending || allow.isPending || allowAll.isPending}
              placeholder={running ? `${who === 'the agent' ? 'The agent' : who} is working. You can stop it, or wait to send the next message.` : editing ? 'What next?' : 'Ask a follow-up…'}
              repoId={repo.id}
            />
          </div>
        </div>
      </section>
      {editing ? <ChangesPanel repo={repo} running={running} editEvents={editEvents} open={showChanges} onClose={() => setShowChanges(false)} /> : null}
    </div>
  );
}

export function TabView({ tab, repo }: { tab: WorkspaceTab; repo: RepoDTO }) {
  return tab.sessionId ? <RunningSession key={tab.sessionId} repo={repo} tab={tab} sessionId={tab.sessionId} /> : <NewSession key={tab.key} repo={repo} tab={tab} />;
}

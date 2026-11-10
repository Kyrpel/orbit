import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  formatDuration,
  type AgentPlanItem,
  type BlockedCommand,
  type ChatAttachmentDTO,
  type ChatEventDTO,
  type ChatImageInput,
  type ChatMessageDTO,
  type ConversationDetailDTO,
  type EffortLevel,
  type RepoDTO,
  type SessionApprovalDTO,
} from '@orbit/shared';
import { del, keys, patch, post, useAction, useChat, useSettings } from '../lib/api';
import { buildLiveModel, type LiveRun, type LiveStep } from '../lib/live-steps';
import { imageToken, splitImageTokens } from '../lib/paste';
import { tabs, type WorkspaceTab } from '../lib/tabs';
import { cn } from '../lib/utils';
import { ChangesPanel } from './changes-panel';
import { since, useTick } from './live-steps';
import { Markdown } from './markdown';
import { NewMissionDialog } from './new-mission';
import { modePatch, promptMode, SHORTCUTS, useMenuKeys, usePrompt, useRepoActions, type MenuKind, type PromptMenu, type PromptMode, type PromptOptions, type Provider } from './prompt';
import { modelLabel, PROVIDER_NAME, providerOfRuntime } from './provider';
import { STARTERS } from './session';
/*
  The terminal look of a workspace pane: one Claude Code terminal per project.
  Everything is drawn the way Claude Code draws it, so it reads at a glance for anyone
  who uses it: `>` for you, `⏺ Tool(target)` for each step with `⎿` results under it,
  the boxed prompt with the mode line below (shift+tab cycles it), slash commands,
  numbered permission prompts, and `✻ Working…` while the agent works.
*/

type PaneState = 'working' | 'needs' | 'done' | 'failed' | 'new';

/** U+23FA with the text-style selector, so it never turns into a coloured emoji. */
const DOT = '⏺\uFE0E';
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

const MODE_LINE: Record<PromptMode, { text: string; tone: string }> = {
  'ask-first': { text: '? for shortcuts', tone: 't-dim' },
  auto: { text: '⏵⏵ auto-accept on (shift+tab to cycle)', tone: 't-auto' },
  'read-only': { text: '⏸ read-only mode on (shift+tab to cycle)', tone: 't-plan' },
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The animated star Claude Code shows while it works. */
function useSpinner(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => setI((n) => (n + 1) % SPIN.length), 130);
    return () => clearInterval(t);
  }, [active]);
  return active ? (SPIN[i] ?? '✻') : '✻';
}

// ---------------------------------------------------------------------------
// Steps: ⏺ Tool(target) with ⎿ lines under it
// ---------------------------------------------------------------------------

const TOOL_LABEL: Record<string, string> = {
  Bash: 'Bash',
  PowerShell: 'PowerShell',
  Read: 'Read',
  Edit: 'Update',
  MultiEdit: 'Update',
  NotebookEdit: 'Update',
  Write: 'Write',
  Glob: 'Search',
  Grep: 'Search',
  LS: 'List',
  WebFetch: 'Fetch',
  WebSearch: 'Web Search',
  Task: 'Task',
  Agent: 'Task',
  TodoWrite: 'Update Todos',
  Skill: 'Skill',
};

function toolLabel(s: LiveStep): string {
  if (s.tool) return TOOL_LABEL[s.tool] ?? s.tool;
  switch (s.kind) {
    case 'run':
    case 'blocked':
      return 'Bash';
    case 'read':
      return s.verb.done === 'Listed' ? 'List' : 'Read';
    case 'edit':
      return s.verb.done === 'Wrote' ? 'Write' : 'Update';
    case 'search':
      return 'Search';
    case 'web':
      return s.verb.done.startsWith('Searched') ? 'Web Search' : 'Fetch';
    case 'delegate':
      return 'Task';
    case 'plan':
      return 'Update Todos';
    default:
      return s.verb.done && s.verb.done !== 'Used' ? s.verb.done : 'Tool';
  }
}

function toolArg(s: LiveStep, folder: string): string {
  const o = folder && s.object.startsWith(`${folder}/`) ? s.object.slice(folder.length + 1) : s.object;
  if (s.kind === 'search') return `pattern: "${o}"`;
  if (s.kind === 'web' && s.verb.done.startsWith('Searched')) return `"${o}"`;
  return o;
}

function Dot({ tone, blink, children }: { tone: string; blink?: boolean; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[2ch_minmax(0,1fr)]">
      <span className={cn('select-none', tone, blink && 'term-blink')} aria-hidden>
        {DOT}
      </span>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

/** `  ⎿  ` and what follows it, aligned the way the terminal aligns it. */
function Tail({ children, tone = 't-dim' }: { children: ReactNode; tone?: string }) {
  return (
    <div className="grid grid-cols-[5ch_minmax(0,1fr)]">
      <span className="select-none pl-[2ch] t-dim" aria-hidden>
        ⎿
      </span>
      <div className={cn('min-w-0 whitespace-pre-wrap break-words', tone)}>{children}</div>
    </div>
  );
}

function More({ count, onClick }: { count: number; onClick?: () => void }) {
  if (count <= 0) return null;
  const text = `… +${plural(count, 'line')}`;
  return onClick ? (
    <button type="button" onClick={onClick} className="block text-left t-dim hover:t-fg">
      {text} (click to expand)
    </button>
  ) : (
    <span className="block t-dim">{text}</span>
  );
}

function DiffLine({ line }: { line: string }) {
  const sign = line[0];
  return (
    <div className={cn('grid grid-cols-[2ch_minmax(0,1fr)] whitespace-pre-wrap break-all', sign === '+' ? 't-add' : sign === '-' ? 't-del' : 't-dim')}>
      <span className="select-none">{sign === '+' || sign === '-' ? sign : ' '}</span>
      <span>{line.slice(1) || ' '}</span>
    </div>
  );
}

function PlanLine({ item }: { item: AgentPlanItem }) {
  const done = item.status === 'completed';
  return (
    <div className={cn('grid grid-cols-[2ch_minmax(0,1fr)]', done ? 'line-through t-dim' : item.status === 'in_progress' ? 'font-bold t-fg' : 't-fg')}>
      <span aria-label={done ? 'Done' : item.status === 'in_progress' ? 'In progress' : 'To do'}>{done ? '☒' : '☐'}</span>
      <span>{item.text}</span>
    </div>
  );
}

const FOLD = 12;

function StepBlock({ step, folder }: { step: LiveStep; folder: string }) {
  const [open, setOpen] = useState(false);
  const label = toolLabel(step);
  const arg = toolArg(step, folder);
  const blocked = step.kind === 'blocked';
  const out = step.output ?? null;
  const tone = step.status === 'running' ? 't-claude' : blocked ? 't-warn' : step.status === 'failed' ? 't-err' : step.status === 'stopped' ? 't-faint' : 't-ok';

  let tail: ReactNode = null;
  if (step.kind === 'plan' && step.plan?.length) {
    tail = (
      <Tail tone="t-fg">
        {step.plan.map((it, i) => (
          <PlanLine key={i} item={it} />
        ))}
      </Tail>
    );
  } else if (blocked) {
    tail = <Tail tone="t-warn">Needs your OK</Tail>;
  } else if (step.status === 'failed' && step.detail) {
    const lines = step.detail.replace(/\s+$/, '').split('\n');
    const shown = open ? lines : lines.slice(0, 3);
    tail = (
      <Tail tone="t-err">
        {`Error: ${shown.join('\n')}`}
        <More count={lines.length - shown.length} onClick={() => setOpen(true)} />
      </Tail>
    );
  } else if (out?.diff?.length) {
    const shown = open ? out.diff : out.diff.slice(0, FOLD);
    const total = Math.max(out.lines ?? 0, out.diff.length);
    tail = (
      <Tail>
        <div>{label === 'Write' ? `Wrote ${plural(out.added ?? 0, 'line')} to ${arg}` : `Updated ${arg} with ${plural(out.added ?? 0, 'addition')} and ${plural(out.removed ?? 0, 'removal')}`}</div>
        <div className="mt-[0.15em]">
          {shown.map((l, i) => (
            <DiffLine key={i} line={l} />
          ))}
        </div>
        <More count={total - shown.length} onClick={out.diff.length > shown.length ? () => setOpen(true) : undefined} />
      </Tail>
    );
  } else if (out?.text) {
    const lines = out.text.split('\n');
    tail = (
      <Tail>
        {out.text}
        <More count={(out.lines ?? 0) - lines.length} />
      </Tail>
    );
  } else if (step.status === 'running' && step.kind === 'run') {
    tail = <Tail>Running…</Tail>;
  } else if (step.status === 'stopped') {
    tail = <Tail>Interrupted</Tail>;
  }

  return (
    <div>
      <Dot tone={tone} blink={step.status === 'running'}>
        <span className="font-bold t-fg">{label}</span>
        {step.kind === 'plan' ? null : <span className="t-fg">({arg})</span>}
      </Dot>
      {tail}
    </div>
  );
}

/** Your message: `>` and the text, with `[Image #1]` linking to the image you attached. */
function UserLine({ text, attachments = [], dim, strike, children }: { text: string; attachments?: ChatAttachmentDTO[]; dim?: boolean; strike?: boolean; children?: ReactNode }) {
  const parts = splitImageTokens(text);
  const mentioned = new Set(parts.filter((x): x is { n: number } => typeof x !== 'string').map((x) => x.n));
  const extra = attachments.map((_, i) => i + 1).filter((n) => !mentioned.has(n));
  const link = (n: number, key: string | number) => {
    const a = attachments[n - 1];
    return a ? (
      <a key={key} href={a.url} target="_blank" rel="noreferrer" className="t-perm underline underline-offset-2" title={`${a.name} (opens the image)`}>
        {imageToken(n)}
      </a>
    ) : (
      <span key={key}>{imageToken(n)}</span>
    );
  };
  return (
    <div className={cn('t-user -mx-[1ch] grid grid-cols-[2ch_minmax(0,1fr)] px-[1ch] py-[0.1em]', dim && 'opacity-75')}>
      <span className="select-none t-dim" aria-label="You">
        &gt;
      </span>
      <div className="min-w-0">
        <span className={cn('whitespace-pre-wrap break-words', strike ? 'line-through t-dim' : 't-fg')}>
          {parts.map((x, i) => (typeof x === 'string' ? x : link(x.n, i)))}
          {extra.map((n) => (
            <span key={`x${n}`}> {link(n, `l${n}`)}</span>
          ))}
        </span>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The transcript: your messages and each answer with its steps
// ---------------------------------------------------------------------------

const SHOW_LAST = 14;

function Turn({
  msg,
  events,
  isLast,
  folder,
  steered,
  onRetry,
  onStop,
}: {
  msg: ChatMessageDTO;
  events: ChatEventDTO[];
  isLast: boolean;
  folder: string;
  steered: ChatMessageDTO[];
  onRetry: () => void;
  onStop: () => void;
}) {
  const running = msg.status === 'running';
  const model = useMemo(() => buildLiveModel(events, running, { planSteps: true }), [events, running]);
  const tick = useTick(running);
  const glyph = useSpinner(running);
  const [showAll, setShowAll] = useState(false);
  const [mission, setMission] = useState(false);
  const runs = model.blocks.filter((b): b is LiveRun => b.type === 'run');
  const final = msg.content.trim();
  // The final message is shown once, at the end, as the answer.
  const items = runs.flatMap((r) => r.steps).filter((s) => !(s.kind === 'say' && (s.detail ?? '').trim() === final));
  type Line = { key: string; ts: string; step?: LiveStep; you?: ChatMessageDTO };
  const lines: Line[] = [...items.map((s) => ({ key: `s${s.id}`, ts: s.ts, step: s })), ...steered.map((m) => ({ key: m.id, ts: m.createdAt, you: m }))].sort((a, b) => a.ts.localeCompare(b.ts));
  const cut = !showAll && lines.length > SHOW_LAST + 2 ? lines.length - SHOW_LAST : 0;
  // Your own messages stay visible even when earlier steps are folded away.
  const shown = cut ? [...lines.slice(0, cut).filter((l) => !!l.you), ...lines.slice(cut)] : lines;
  const hidden = cut ? lines.slice(0, cut).filter((l) => !l.you).length : 0;
  const notes = model.blocks.filter((b) => b.type === 'milestone');
  const current = [...items].reverse().find((s) => s.status === 'running' && s.kind !== 'say' && s.kind !== 'note');
  const ai = [PROVIDER_NAME[providerOfRuntime(msg.runtime) ?? ''], modelLabel(msg.model)?.replace(/^Claude /, '')].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-[0.9em]">
      {hidden ? (
        <button type="button" onClick={() => setShowAll(true)} className="text-left t-dim hover:t-fg">
          … +{plural(hidden, 'earlier step')} (click to show)
        </button>
      ) : null}
      {shown.map(({ key, step, you }) =>
        you ? (
          <UserLine key={key} text={you.content} attachments={you.attachments} />
        ) : step?.kind === 'say' ? (
          <Dot key={key} tone="t-fg">
            <Markdown variant="terminal" text={step.detail ?? step.object} />
          </Dot>
        ) : step?.kind === 'note' ? (
          <Tail key={key}>{step.object}</Tail>
        ) : step ? (
          <StepBlock key={key} step={step} folder={folder} />
        ) : null,
      )}
      {notes.map((n) => (
        <Tail key={n.key} tone={n.tone === 'bad' ? 't-err' : 't-dim'}>
          {n.title}
        </Tail>
      ))}
      {final && !running ? (
        <Dot tone="t-fg">
          <Markdown variant="terminal" text={final} />
        </Dot>
      ) : null}
      {msg.status === 'cancelled' ? <Tail tone="t-err">Interrupted by you</Tail> : null}
      {msg.status === 'failed' ? (
        <Dot tone="t-err">
          <span className="t-err">{msg.error ?? 'Something went wrong.'}</span>
          {isLast ? (
            <>
              {' '}
              <button type="button" onClick={onRetry} className="t-dim underline underline-offset-2 hover:t-fg">
                try again
              </button>
            </>
          ) : null}
        </Dot>
      ) : null}
      {running ? (
        <div className="t-claude" aria-live="polite">
          <span className="inline-block w-[2ch]">{glyph}</span>
          {current ? `${current.verb.doing}…` : 'Thinking…'}{' '}
          <span className="t-dim">
            ({since(msg.createdAt, tick)} ·{' '}
            <button type="button" onClick={onStop} className="hover:t-fg">
              esc to interrupt
            </button>
            )
          </span>
        </div>
      ) : msg.status === 'done' && msg.durationMs != null ? (
        <div className="t-faint">
          ✻ Worked for {formatDuration(msg.durationMs)}
          {ai ? ` · ${ai}` : ''}
        </div>
      ) : null}
      {msg.suggestion ? (
        <div>
          <Dot tone="t-perm">
            <span className="t-fg">This is bigger than a quick answer. Hand it to Autopilot?</span>
          </Dot>
          <Tail tone="t-fg">{msg.suggestion.title}</Tail>
          <div className="pl-[5ch]">
            <button type="button" onClick={() => setMission(true)} className="t-perm hover:underline">
              ❯ Start in Autopilot
            </button>
          </div>
          {mission ? <NewMissionDialog key={msg.id} open={mission} onOpenChange={setMission} initial={msg.suggestion} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function Transcript({ chat, folder, onRetry, onUnqueue, onStop }: { chat: ConversationDetailDTO; folder: string; onRetry: (q: string) => void; onUnqueue: (id: string) => void; onStop: () => void }) {
  const byMessage = useMemo(() => {
    const map = new Map<string, ChatEventDTO[]>();
    for (const e of chat.events) map.set(e.messageId, [...(map.get(e.messageId) ?? []), e]);
    return map;
  }, [chat.events]);
  // A message delivered mid-answer belongs inside the answer that was running when you sent it.
  const steeredBy = useMemo(() => {
    const map = new Map<string, ChatMessageDTO[]>();
    let current: string | null = null;
    for (const m of chat.messages) {
      if (m.role === 'assistant') current = m.id;
      else if (m.status === 'steered' && current) map.set(current, [...(map.get(current) ?? []), m]);
    }
    return map;
  }, [chat.messages]);
  const lastAgent = [...chat.messages].reverse().find((m) => m.role === 'assistant')?.id;
  return (
    <div className="flex flex-col gap-[1em]">
      {chat.messages.map((m, i) =>
        m.role === 'user' ? (
          m.status === 'steered' ? null : (
            <UserLine key={m.id} text={m.content} attachments={m.attachments} dim={m.status === 'queued'} strike={m.status === 'cancelled'}>
              {m.status === 'queued' ? (
                <span className="t-dim">
                  {' '}
                  (queued, sends when the agent finishes ·{' '}
                  <button type="button" onClick={() => onUnqueue(m.id)} className="underline underline-offset-2 hover:t-fg">
                    remove
                  </button>
                  )
                </span>
              ) : m.status === 'cancelled' && m.error ? (
                <span className="block t-dim">{m.error}</span>
              ) : null}
            </UserLine>
          )
        ) : (
          <Turn
            key={m.id}
            msg={m}
            events={byMessage.get(m.id) ?? []}
            isLast={m.id === lastAgent}
            folder={folder}
            steered={steeredBy.get(m.id) ?? []}
            onStop={onStop}
            onRetry={() => {
              const q = [...chat.messages.slice(0, i)].reverse().find((x) => x.role === 'user');
              if (q) onRetry(q.content);
            }}
          />
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numbered choices: permission prompts and pickers, like Claude Code's
// ---------------------------------------------------------------------------

function DialogBox({ dialog, autoFocus }: { dialog: PromptMenu; autoFocus: boolean }) {
  const { sel, setSel, box, pick, onKeyDown } = useMenuKeys(dialog, autoFocus);
  const tone = dialog.tone === 'perm' ? 't-perm' : dialog.tone === 'warn' ? 't-warn' : 't-fg';
  return (
    <div>
      <div
        ref={box}
        data-term-focus
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-label={typeof dialog.title === 'string' ? dialog.title : 'Choose an option'}
        className={cn('rounded-[6px] border px-[1ch] py-[0.45em] outline-none', dialog.tone === 'perm' ? 't-box-perm' : dialog.tone === 'warn' ? 't-box-warn' : 't-box')}
      >
        <div className={cn('font-bold', tone)}>{dialog.title}</div>
        {dialog.body ? <div className="mt-[0.7em] whitespace-pre-wrap t-dim">{dialog.body}</div> : null}
        {dialog.question ? <div className="mt-[0.7em] max-h-[40vh] overflow-y-auto whitespace-pre-wrap t-fg">{dialog.question}</div> : null}
        <div role="listbox" className="mt-[0.3em]">
          {dialog.options.map((o, i) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
              className={cn('grid w-full grid-cols-[2ch_minmax(0,1fr)] text-left', i === sel ? 't-perm' : 't-fg')}
            >
              <span aria-hidden>{i === sel ? '❯' : ' '}</span>
              <span>
                {i + 1}. {o.label}
                {o.current ? <span className="t-ok"> ✔</span> : null}
                {o.hint ? <span className="t-dim"> {o.hint}</span> : null}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="px-[1ch] pt-[0.15em] t-dim">{dialog.footer ?? 'Enter to confirm · Esc to cancel'}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The prompt: boxed `>` input, slash commands, the mode line
// ---------------------------------------------------------------------------

function TermInput({ external, active, placeholder, ...opts }: PromptOptions & { external: PromptMenu | null; active: boolean; placeholder: string }) {
  const p = usePrompt(opts);
  const dialog = external ?? p.picker ?? p.proposalMenu;
  if (dialog) return <DialogBox dialog={dialog} autoFocus={active} />;

  const line = opts.security ? { text: '⏸ read-only security check', tone: 't-plan' } : !opts.canEdit ? { text: '⏸ read-only project', tone: 't-plan' } : MODE_LINE[opts.mode];
  return (
    <div {...p.dropProps}>
      {p.improving ? <div className="px-[1ch] pb-[0.2em] t-claude">✻ Improving your request…</div> : null}
      {p.notice ? <div className="px-[1ch] pb-[0.2em] t-warn">{p.notice}</div> : null}
      {p.images.length ? (
        <div className="flex flex-wrap gap-x-[2ch] px-[1ch] pb-[0.2em] t-dim">
          {p.images.map((img) => (
            <span key={img.n}>
              <span className="t-perm">{imageToken(img.n)}</span> {img.width}×{img.height}{' '}
              <button type="button" onClick={() => p.removeImage(img.n)} className="hover:t-fg" aria-label={`Remove image ${img.n}`} title="Remove">
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className={cn('rounded-[6px] border px-[1ch] py-[0.15em]', p.dragging ? 't-box-perm' : 't-box focus-within:t-box-claude')}>
        <div className="grid grid-cols-[2ch_minmax(0,1fr)]">
          <span className="select-none t-fg" aria-hidden>
            &gt;
          </span>
          <textarea
            {...p.textarea}
            data-term-focus
            rows={1}
            placeholder={p.dragging ? 'Drop the image to attach it' : (p.ghost ?? placeholder)}
            aria-label={`Message for ${opts.repo.name}`}
            autoFocus={active}
            spellCheck={false}
            className="block w-full min-w-0 resize-none bg-transparent leading-[inherit] t-fg outline-none placeholder:t-faint"
          />
        </div>
      </div>
      {p.suggestions.length ? (
        <div className="px-[1ch] pt-[0.2em]" role="listbox" aria-label="Commands">
          {p.suggestions.slice(p.windowStart, p.windowStart + 8).map((c, n) => {
            const i = p.windowStart + n;
            return (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === p.sel}
                onMouseEnter={() => p.setSlashSel(i)}
                onClick={() => p.runSlash(c, '')}
                className={cn('grid w-full grid-cols-[14ch_minmax(0,1fr)] text-left', i === p.sel ? 't-perm' : 't-dim')}
              >
                <span>/{c.name}</span>
                <span className="truncate">{c.hint}</span>
              </button>
            );
          })}
          {p.suggestions.length > 8 ? <div className="t-faint">↑↓ for more · tab to complete</div> : null}
        </div>
      ) : p.help ? (
        <div className="px-[1ch] pt-[0.2em] t-dim">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(30ch,1fr))] gap-x-[3ch]">
            {SHORTCUTS.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
          <div className="mt-[0.5em] grid grid-cols-[14ch_minmax(0,1fr)]">
            {p.slashes.map((c) => (
              <div key={c.name} className="contents">
                <span>/{c.name}</span>
                <span className="truncate">{c.hint}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-x-[2ch] px-[1ch] pt-[0.15em]">
          {p.ghost ? (
            <span className="t-dim">tab to use the suggestion</span>
          ) : (
            <button type="button" onClick={p.cycleMode} className={cn('text-left', line.tone)} title="Change mode (shift+tab)">
              {line.text}
            </button>
          )}
          {!opts.security ? (
            <span className="t-dim">
              <button type="button" onClick={() => p.openMenu('ai')} className="hover:t-fg" title="Which AI answers (/ai)">
                {p.status.aiText}
              </button>
              {' · '}
              <button type="button" onClick={() => p.openMenu('model')} className="hover:t-fg" title="Model for this session (/model)">
                {p.status.modelText}
              </button>
              {' · '}
              <button type="button" onClick={() => p.openMenu('effort')} className="hover:t-fg" title="Reasoning effort (/effort)">
                {p.status.effortText}
              </button>
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The pane: title line, transcript, prompt
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<PaneState, string> = { working: 'Working', needs: 'Needs your OK', done: 'Finished', failed: 'Stopped with a problem', new: 'New session' };

function TitleBar({
  repo,
  tab,
  title,
  state,
  onChanges,
  changesOpen,
  onSessions,
  onExpand,
}: {
  repo: RepoDTO;
  tab: WorkspaceTab;
  title: string;
  state: PaneState;
  onChanges?: () => void;
  changesOpen?: boolean;
  onSessions: () => void;
  onExpand?: () => void;
}) {
  const glyph = useSpinner(state === 'working');
  const tone = state === 'working' ? 't-claude' : state === 'needs' ? 't-warn' : state === 'failed' ? 't-err' : state === 'done' ? 't-ok' : 't-dim';
  const btn = 'hover:t-fg';
  return (
    <div className="flex h-[2em] shrink-0 items-center gap-[1ch] border-b t-sep px-[1.5ch]">
      <span className={cn('w-[1.5ch] shrink-0 text-center', tone)} role="img" aria-label={STATE_LABEL[state]} title={STATE_LABEL[state]}>
        {state === 'working' ? glyph : '✳'}
      </span>
      <span className="min-w-0 truncate" title={repo.localPath}>
        <span className="font-bold t-fg">{repo.name}</span>
        <span className="t-dim"> · {title}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-[1.5ch] t-dim">
        {onChanges ? (
          <button type="button" onClick={onChanges} className={cn(btn, changesOpen && 't-fg')} aria-expanded={changesOpen} title="What changed, commit, security check (/changes)">
            changes
          </button>
        ) : null}
        <button type="button" onClick={onSessions} className={btn} title="Other sessions in this project (/resume)">
          sessions
        </button>
        {onExpand ? (
          <button type="button" onClick={onExpand} className={btn} aria-label={`Open ${repo.name} full size`} title="Full size">
            ⤢
          </button>
        ) : null}
        <button type="button" onClick={() => tabs.close(tab.key)} className={btn} aria-label={`Close ${repo.name}`} title="Close this pane (the session is kept)">
          ✕
        </button>
      </span>
    </div>
  );
}

/** A click anywhere in the pane puts the cursor in its prompt, as in a terminal. */
function useClickToFocus() {
  const root = useRef<HTMLDivElement>(null);
  const onMouseUp = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select, [role="dialog"]')) return;
    if (window.getSelection()?.toString()) return;
    root.current?.querySelector<HTMLElement>('[data-term-focus]')?.focus({ preventScroll: true });
  };
  return { root, onMouseUp };
}

/** Keeps the transcript at the bottom while you are reading the bottom. */
function useStickToBottom(size: number) {
  const box = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && near.current) el.scrollTop = el.scrollHeight;
  }, [size]);
  const onScroll = () => {
    const el = box.current;
    if (el) near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  return { box, onScroll };
}

const PANE = 'flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--t-bg)] text-[13.5px] leading-[1.45] t-fg';

function TermRunning({ repo, tab, sessionId, active, onExpand }: { repo: RepoDTO; tab: WorkspaceTab; sessionId: string; active: boolean; onExpand?: () => void }) {
  const navigate = useNavigate();
  const chat = useChat(sessionId);
  const invalidate = [keys.chats, keys.chat(sessionId)];
  const send = useAction((v: { message: string; now?: boolean; images?: ChatImageInput[] }) => post<ConversationDetailDTO>(`/api/chats/${sessionId}/messages`, v), { invalidate });
  const unqueue = useAction((messageId: string) => del<ConversationDetailDTO>(`/api/chats/${sessionId}/messages/${messageId}`), { invalidate });
  const stop = useAction(() => post(`/api/chats/${sessionId}/cancel`), { invalidate });
  const update = useAction((v: Record<string, unknown>) => patch(`/api/chats/${sessionId}`, v), { invalidate });
  const allow = useAction((command: string) => post<ConversationDetailDTO>(`/api/chats/${sessionId}/allow`, { command }), { invalidate });
  const allowAll = useAction(() => post<ConversationDetailDTO>(`/api/chats/${sessionId}/allow-all`), { invalidate });
  const approve = useAction((decision: 'accept' | 'acceptForSession' | 'decline') => post<ConversationDetailDTO>(`/api/chats/${sessionId}/approval`, { decision }), { invalidate });
  const remove = useAction(() => del(`/api/chats/${sessionId}`), { success: 'Session deleted', invalidate: [keys.chats] });
  const actions = useRepoActions(repo, tab);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const { root, onMouseUp } = useClickToFocus();
  const c = chat.data;
  const size = c ? c.events.length + c.messages.length * 1000 + (c.messages.at(-1)?.content.length ?? 0) + (c.approval ? 7 : 0) : 0;
  const { box, onScroll } = useStickToBottom(size);

  if (chat.isPending) {
    return (
      <div className={cn(PANE, 'p-[1.5ch]')}>
        <span className="t-claude">✻ Opening the session…</span>
      </div>
    );
  }
  if (chat.error || !c) {
    return (
      <div className={cn(PANE, 'p-[1.5ch]')}>
        <span className="t-err">⏺ Could not open this session: {chat.error?.message ?? 'not found'}</span>
      </div>
    );
  }

  const running = c.messages.some((m) => m.status === 'running');
  const editing = c.mode === 'edit';
  const canEdit = repo.allowModify && repo.isGit;
  const securitySeat = c.seat === 'security';
  const lastAgent = [...c.messages].reverse().find((m) => m.role === 'assistant');
  const blocked: BlockedCommand[] = !running && lastAgent ? lastAgent.blocked.filter((b) => !dismissed.includes(b.command) && !c.allowedCommands.includes(b.command)) : [];
  const state: PaneState = c.approval || blocked.length ? 'needs' : running ? 'working' : lastAgent?.status === 'failed' ? 'failed' : lastAgent ? 'done' : 'new';
  const ai = c.agentRuntime ? (PROVIDER_NAME[providerOfRuntime(c.agentRuntime) ?? ''] ?? 'The agent') : c.provider === 'auto' ? 'The agent' : PROVIDER_NAME[c.provider];
  const editEvents = c.events.filter((e) => e.kind === 'tool' && (e.data as { step?: string } | null)?.step === 'edit').length;
  const focusPrompt = () => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-term-focus]')?.focus({ preventScroll: true }));

  const approvalDialog = (a: SessionApprovalDTO): PromptMenu => ({
    key: a.id,
    tone: 'perm',
    title: a.kind === 'command' ? 'Command outside the sandbox' : 'File change outside the sandbox',
    body: (
      <div>
        {a.command ? <div className="whitespace-pre-wrap break-all pl-[2ch] t-fg">{a.command}</div> : null}
        {a.reason ? <div className="pl-[2ch] t-dim">{a.reason}</div> : null}
        <div className="pl-[2ch] t-dim">
          {ai}&apos;s sandbox blocks this on its own{a.network ? ' (it needs network access)' : ''}.
        </div>
      </div>
    ),
    question: 'Do you want to proceed?',
    options: [
      { label: 'Yes', run: () => approve.mutate('accept') },
      { label: "Yes, and don't ask again for this in this session", run: () => approve.mutate('acceptForSession') },
      { label: `No, and tell ${ai === 'The agent' ? 'the agent' : ai} what to do differently`, hint: '(esc)', run: () => (approve.mutate('decline'), focusPrompt()) },
    ],
    onCancel: () => (approve.mutate('decline'), focusPrompt()),
  });

  const blockedDialog = (b: BlockedCommand): PromptMenu => {
    const dismiss = () => (setDismissed([...dismissed, b.command]), focusPrompt());
    return {
      key: `blocked:${b.command}`,
      tone: 'perm',
      title: `${b.tool === 'PowerShell' ? 'PowerShell' : 'Bash'} command`,
      body: <div className="whitespace-pre-wrap break-all pl-[2ch] t-fg">{b.command}</div>,
      question: 'Do you want to proceed?',
      options: [
        ...(b.allowable ? [{ label: 'Yes', run: () => allow.mutate(b.command) }] : []),
        { label: "Yes, and don't ask again this session", hint: '(auto-accept)', run: () => allowAll.mutate(undefined) },
        { label: 'No, and tell the agent what to do differently', hint: '(esc)', run: dismiss },
      ],
      onCancel: dismiss,
      footer: b.allowable ? undefined : 'Enter to confirm · Esc to cancel · this command is too long to allow on its own',
    };
  };

  const external = c.approval ? approvalDialog(c.approval) : blocked[0] ? blockedDialog(blocked[0]) : null;
  const history = c.messages.filter((m) => m.role === 'user').map((m) => m.content).reverse();

  return (
    <div ref={root} onMouseUp={onMouseUp} className={PANE}>
      <TitleBar
        repo={repo}
        tab={tab}
        title={securitySeat ? `Security check · ${c.title}` : c.title}
        state={state}
        onChanges={editing || canEdit ? () => setShowChanges(!showChanges) : undefined}
        changesOpen={showChanges}
        onSessions={() => setMenu('resume')}
        onExpand={onExpand}
      />
      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-[1.5ch] pb-[0.6em] pt-[0.8em]">
        <Transcript
          chat={c}
          folder={repo.localPath.split(/[\\/]/).filter(Boolean).pop() ?? ''}
          onRetry={(q) => send.mutate({ message: q })}
          onUnqueue={(id) => unqueue.mutate(id)}
          onStop={() => stop.mutate(undefined)}
        />
      </div>
      <div className="shrink-0 px-[1.5ch] pb-[0.6em]">
        <TermInput
          repo={repo}
          sessionId={sessionId}
          canEdit={canEdit}
          security={securitySeat}
          value={draft}
          onChange={setDraft}
          mode={promptMode(c.mode, c.permissionMode)}
          onMode={(m) => update.mutate(modePatch(m))}
          provider={c.provider}
          onProvider={(p) => update.mutate({ provider: p, model: null })}
          model={c.model}
          onModel={(m) => update.mutate({ model: m })}
          effort={c.effort}
          onEffort={(e) => update.mutate({ effort: e })}
          running={running}
          sending={send.isPending}
          onSubmit={(message, images, now, done) => send.mutate({ message, now, ...(images.length ? { images } : {}) }, { onSuccess: done })}
          onStop={() => stop.mutate(undefined)}
          external={external}
          menu={menu}
          setMenu={setMenu}
          history={history}
          active={active}
          suggestion={c.nextPrompt}
          placeholder={running ? (c.steerable ? `Message ${ai === 'The agent' ? 'the agent' : ai}: it reads it at its next step` : 'Type a message: it is sent when the agent finishes') : ''}
          commands={{
            clear: actions.clear,
            open: actions.open,
            ...(canEdit
              ? {
                  changes: () => setShowChanges(true),
                  commit: (m: string) => actions.commit(m, () => setShowChanges(true)),
                  security: actions.security,
                }
              : {}),
            close: () => tabs.close(tab.key),
            ...(onExpand ? { expand: onExpand } : {}),
            remove: () =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  tabs.close(tab.key);
                  navigate('/');
                },
              }),
          }}
        />
      </div>
      {canEdit ? <ChangesPanel repo={repo} running={running} editEvents={editEvents} open={showChanges} onClose={() => setShowChanges(false)} docked={false} /> : null}
    </div>
  );
}

function TermNew({ repo, tab, active, onExpand }: { repo: RepoDTO; tab: WorkspaceTab; active: boolean; onExpand?: () => void }) {
  const navigate = useNavigate();
  const settings = useSettings();
  const canEdit = repo.allowModify && repo.isGit;
  const [draft, setDraft] = useState('');
  const [sentText, setSentText] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>('auto');
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<EffortLevel | null>(null);
  const [choice, setChoice] = useState<PromptMode | null>(null);
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const actions = useRepoActions(repo, tab);
  const { root, onMouseUp } = useClickToFocus();
  const mode: PromptMode = !canEdit ? 'read-only' : (choice ?? (settings.data?.execution.sessionCommands === 'auto' ? 'auto' : 'ask-first'));
  const start = useAction(
    (v: { message: string; images: ChatImageInput[] }) => {
      const m = modePatch(mode);
      return post<ConversationDetailDTO>('/api/chats', {
        message: v.message,
        ...(v.images.length ? { images: v.images } : {}),
        repoIds: [repo.id],
        mode: m.mode,
        provider,
        permissionMode: m.permissionMode ?? settings.data?.execution.sessionCommands ?? 'ask',
        model,
        effort,
      });
    },
    { invalidate: [keys.chats] },
  );
  const focusPrompt = () => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-term-focus]')?.focus({ preventScroll: true }));
  const tips = STARTERS.filter((s) => mode !== 'read-only' || s.label === 'Explain this project');

  return (
    <div ref={root} onMouseUp={onMouseUp} className={PANE}>
      <TitleBar repo={repo} tab={tab} title="new session" state="new" onChanges={canEdit ? () => setShowChanges(!showChanges) : undefined} changesOpen={showChanges} onSessions={() => setMenu('resume')} onExpand={onExpand} />
      <div className="min-h-0 flex-1 overflow-y-auto px-[1.5ch] pb-[0.6em] pt-[0.8em]">
        <div className="flex flex-col gap-[1em]">
          <div className="w-fit max-w-full rounded-[6px] border t-box-claude px-[1ch] py-[0.45em]">
            <div>
              <span className="t-claude">✻</span> <span className="font-bold">Orbit</span>
              <span className="t-dim"> · {repo.name}</span>
            </div>
            <div className="mt-[0.9em] pl-[2ch] t-dim">/help for commands, shift+tab to change mode</div>
            <div className="mt-[0.9em] break-all pl-[2ch] t-dim">cwd: {repo.localPath}</div>
          </div>
          <div>
            <div className="t-dim">Tips for getting started:</div>
            {tips.map((s, i) => (
              <button
                key={s.label}
                type="button"
                onClick={() => {
                  setDraft(s.text);
                  focusPrompt();
                }}
                className="grid w-full grid-cols-[3ch_minmax(0,1fr)] text-left t-dim hover:t-fg"
              >
                <span>{i + 1}.</span>
                <span>{s.label}</span>
              </button>
            ))}
          </div>
          {sentText ? (
            <>
              <UserLine text={sentText} />
              <div className="t-claude">✻ Starting…</div>
            </>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 px-[1.5ch] pb-[0.6em]">
        <TermInput
          repo={repo}
          sessionId={null}
          canEdit={canEdit}
          security={false}
          value={draft}
          onChange={setDraft}
          mode={mode}
          onMode={setChoice}
          provider={provider}
          onProvider={(p) => {
            setProvider(p);
            setModel(null);
          }}
          model={model}
          onModel={setModel}
          effort={effort}
          onEffort={setEffort}
          running={false}
          sending={start.isPending}
          onSubmit={(message, images, _now, done) => {
            setSentText(message);
            start.mutate({ message, images }, {
              onSuccess: (c) => {
                done();
                tabs.attach(tab.key, c.id);
                navigate(`/s/${c.id}`);
              },
              onError: () => setSentText(null),
            });
          }}
          external={null}
          menu={menu}
          setMenu={setMenu}
          history={[]}
          active={active}
          placeholder={mode === 'read-only' ? `Ask about ${repo.name}…` : 'Try "explain this project" or describe a change'}
          commands={{
            clear: () => setDraft(''),
            open: actions.open,
            ...(canEdit
              ? {
                  changes: () => setShowChanges(true),
                  commit: (m: string) => actions.commit(m, () => setShowChanges(true)),
                  security: actions.security,
                }
              : {}),
            close: () => tabs.close(tab.key),
            ...(onExpand ? { expand: onExpand } : {}),
          }}
        />
      </div>
      {canEdit ? <ChangesPanel repo={repo} running={false} editEvents={0} open={showChanges} onClose={() => setShowChanges(false)} docked={false} /> : null}
    </div>
  );
}

/** A workspace pane in the terminal look. `active`: the pane you are working in (it takes the keyboard). */
export function TerminalTabView({ tab, repo, active = true, onExpand }: { tab: WorkspaceTab; repo: RepoDTO; active?: boolean; onExpand?: () => void }) {
  return tab.sessionId ? (
    <TermRunning key={tab.sessionId} repo={repo} tab={tab} sessionId={tab.sessionId} active={active} onExpand={onExpand} />
  ) : (
    <TermNew key={tab.key} repo={repo} tab={tab} active={active} onExpand={onExpand} />
  );
}

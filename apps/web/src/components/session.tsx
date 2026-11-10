import { AlertTriangle, ArrowUp, Check, ChevronDown, Clock3, Copy, History, Loader2, Maximize2, Plus, RotateCcw, ShieldCheck, SlidersHorizontal, Square, Trash2, Wand2, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import type { ChatEventDTO, ChatImageInput, ChatMessageDTO, ConversationDetailDTO, ConversationSummaryDTO, RepoDTO, SessionApprovalDTO, SessionMode, SessionPermissionMode } from '@orbit/shared';
import { EFFORT_INFO, EFFORT_LEVELS, formatDuration, type EffortLevel } from '@orbit/shared';
import { buildLiveModel, type LiveRun, type LiveStep } from '../lib/live-steps';
import { del, keys, patch, post, useAction, useAgents, useChat, useChats, useSettings, useTeam } from '../lib/api';
import { tabs, type WorkspaceTab } from '../lib/tabs';
import { cn, timeAgo } from '../lib/utils';
import { ChangesPanel } from './changes-panel';
import { KIND_ICON, Plan, since, useTick } from './live-steps';
import { Markdown } from './markdown';
import { modePatch, promptMode, SHORTCUTS, useMenuKeys, usePrompt, useRepoActions, type MenuKind, type PromptMenu, type PromptMode, type PromptOptions } from './prompt';
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

/** Which model this tab uses. "Default" is the session agent's model for that AI (Agents page). */
export function ModelPicker({ provider, value, onChange }: { provider: Provider; value: string | null; onChange: (m: string | null) => void }) {
  const team = useTeam();
  const agents = useAgents();
  const seat = agents.data?.find((a) => a.role === 'assistant');
  const ai = provider === 'auto' ? (seat?.resolved.provider === 'codex' ? 'codex' : 'claude') : provider;
  const list = team.data?.providers.find((p) => p.provider === ai)?.models ?? [];
  const fallback = ai === 'codex' ? seat?.codexModel : seat?.model;
  const fits = (m: string | null | undefined) => !!m && (ai === 'claude') === m.startsWith('claude-');
  const current = fits(value) ? value! : '';
  const name = (m: string | null | undefined) => (m ? (list.find((x) => x.id === m)?.label ?? modelLabel(m) ?? m).replace(/^Claude /, '') : null);
  return (
    <label className="inline-flex items-center gap-1.5 text-2xs text-dust">
      Model
      <select
        value={current}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label="Model for this session"
        title="Applies to this session only. Change the default on the Agents page (Session agent)."
        className="h-8 max-w-[180px] rounded-[8px] border border-seam bg-hull px-2 text-xs text-chalk"
      >
        <option value="">Default ({name(fallback) ?? (ai === 'codex' ? 'Codex setting' : 'agent setting')})</option>
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label.replace(/^Claude /, '')}
          </option>
        ))}
        {current && !list.some((m) => m.id === current) ? <option value={current}>{current}</option> : null}
      </select>
    </label>
  );
}

/** How hard this tab's agent thinks. "Default" is the session agent's effort (Agents page). */
export function EffortPicker({ value, onChange }: { value: EffortLevel | null; onChange: (e: EffortLevel | null) => void }) {
  const agents = useAgents();
  const fallback = agents.data?.find((a) => a.role === 'assistant')?.effort;
  return (
    <label className="inline-flex items-center gap-1.5 text-2xs text-dust">
      Effort
      <select
        value={value ?? ''}
        onChange={(e) => onChange((e.target.value || null) as EffortLevel | null)}
        aria-label="Reasoning effort for this session"
        title={value ? EFFORT_INFO[value].description : 'Higher effort thinks longer and uses more tokens. Applies to this session only.'}
        className="h-8 rounded-[8px] border border-seam bg-hull px-2 text-xs text-chalk"
      >
        <option value="">Default ({fallback ? EFFORT_INFO[fallback].label : 'agent setting'})</option>
        {EFFORT_LEVELS.map((l) => (
          <option key={l} value={l} title={EFFORT_INFO[l].description}>
            {EFFORT_INFO[l].label}
          </option>
        ))}
      </select>
    </label>
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

/** A numbered picker or question, drawn in the white look (same keys as the terminal: ↑↓, Enter, Esc, 1–9). */
function LightMenu({ menu, autoFocus }: { menu: PromptMenu; autoFocus: boolean }) {
  const { sel, setSel, box, pick, onKeyDown } = useMenuKeys(menu, autoFocus);
  return (
    <div
      ref={box}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-label={typeof menu.title === 'string' ? menu.title : 'Choose an option'}
      className={cn(
        'rounded-[14px] border bg-hull p-2 shadow-[0_12px_32px_-18px_rgb(16_24_40/0.35)] outline-none',
        menu.tone === 'perm' ? 'border-telemetry/40' : menu.tone === 'warn' ? 'border-fault/40' : 'border-seam',
      )}
    >
      <div className="flex items-baseline justify-between gap-3 px-2 pt-1">
        <p className={cn('text-sm font-[650]', menu.tone === 'perm' ? 'text-telemetry' : menu.tone === 'warn' ? 'text-fault' : 'text-chalk')}>{menu.title}</p>
        <button type="button" onClick={menu.onCancel} className="text-2xs text-dust hover:text-chalk">
          Esc to close
        </button>
      </div>
      {menu.body ? <p className="whitespace-pre-wrap px-2 pt-1 text-xs text-dust">{menu.body}</p> : null}
      {menu.question ? <pre className="mx-2 mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-6 text-chalk">{menu.question}</pre> : null}
      <ul role="listbox" className="mt-1.5">
        {menu.options.map((o, i) => (
          <li key={i}>
            <button
              type="button"
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
              className={cn('flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-sm transition-colors', i === sel ? 'bg-hull-2' : 'hover:bg-hull-2')}
            >
              <span className="w-4 shrink-0 text-center text-2xs text-dust-2 tabular">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="text-chalk">{o.label}</span>
                {o.hint ? <span className="ml-2 text-xs text-dust">{o.hint}</span> : null}
              </span>
              {o.current ? <Check className="size-4 shrink-0 text-telemetry" aria-label="Current" /> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The message box: type, paste images or long text, `/` for commands, Shift+Tab to change mode. */
export function Composer({ prompt, placeholder, steerable, big, autoFocus = true }: { prompt: PromptOptions; placeholder: string; steerable?: boolean; big?: boolean; autoFocus?: boolean }) {
  const p = usePrompt(prompt);
  const { running, sending, onStop, value } = prompt;
  const menu = p.picker ?? p.proposalMenu;
  const empty = !value.trim() && !p.images.length;
  return (
    <div className="space-y-2">
      {menu ? <LightMenu menu={menu} autoFocus={autoFocus} /> : null}
      {!menu && p.suggestions.length ? (
        <div className="rounded-[14px] border border-seam bg-hull p-1.5 shadow-[0_12px_32px_-18px_rgb(16_24_40/0.35)]" role="listbox" aria-label="Commands">
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
                className={cn('flex w-full items-baseline gap-3 rounded-[8px] px-2.5 py-1.5 text-left', i === p.sel && 'bg-hull-2')}
              >
                <span className="mono w-24 shrink-0 text-sm text-chalk">/{c.name}</span>
                <span className="truncate text-xs text-dust">{c.hint}</span>
              </button>
            );
          })}
          <p className="px-2.5 pb-0.5 pt-1 text-2xs text-dust-2">↑↓ to choose · Enter to run · Tab to complete</p>
        </div>
      ) : null}
      {!menu && !p.suggestions.length && p.help ? (
        <div className="rounded-[14px] border border-seam bg-hull p-3 text-xs shadow-[0_12px_32px_-18px_rgb(16_24_40/0.35)]">
          <p className="text-sm font-[650]">Shortcuts</p>
          <ul className="mt-1.5 grid grid-cols-1 gap-x-6 gap-y-1 text-dust sm:grid-cols-2">
            {SHORTCUTS.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm font-[650]">Commands</p>
          <ul className="mt-1.5 grid grid-cols-1 gap-y-1">
            {p.slashes.map((c) => (
              <li key={c.name} className="flex gap-3">
                <span className="mono w-24 shrink-0 text-chalk">/{c.name}</span>
                <span className="text-dust">{c.hint}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {p.notice ? <p className="px-1 text-xs text-signal-deep">{p.notice}</p> : null}
      <div
        {...p.dropProps}
        className={cn(
          'rounded-[16px] border bg-hull shadow-[0_1px_2px_rgb(16_24_40/0.05)] transition-colors focus-within:border-telemetry/70 focus-within:shadow-[0_0_0_3px_rgb(11_124_113/0.12)]',
          p.dragging ? 'border-telemetry bg-telemetry/[0.04]' : 'border-seam-2',
          big && 'rounded-[18px]',
        )}
      >
        {p.images.length ? (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {p.images.map((img) => (
              <figure key={img.n} className="group relative overflow-hidden rounded-[10px] border border-seam bg-hull-2">
                <img src={img.preview} alt={`Image ${img.n}`} className="block h-16 w-auto max-w-[150px] object-cover" />
                <figcaption className="absolute bottom-0 left-0 rounded-tr-[6px] bg-chalk/75 px-1.5 text-[11px] leading-4 text-hull">#{img.n}</figcaption>
                <button
                  type="button"
                  onClick={() => p.removeImage(img.n)}
                  aria-label={`Remove image ${img.n}`}
                  className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-chalk/75 text-hull opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </figure>
            ))}
          </div>
        ) : null}
        <textarea
          {...p.textarea}
          rows={big ? 3 : 1}
          placeholder={p.dragging ? 'Drop the image to attach it' : (p.ghost ?? placeholder)}
          aria-label="Your message"
          autoFocus={autoFocus}
          className={cn('block max-h-64 w-full resize-none bg-transparent px-4 pt-3 text-chalk outline-none placeholder:text-dust-2', big ? 'min-h-[84px] text-base' : 'min-h-[28px] text-[14.5px]')}
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          <button
            type="button"
            onClick={p.improve}
            disabled={!value.trim() || p.improving}
            className="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-xs text-dust transition-colors hover:bg-hull-2 hover:text-chalk disabled:opacity-40"
            title="Let the Prompt engineer turn your message into a clear, complete request (/improve)"
          >
            {p.improving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Wand2 className="size-3.5" aria-hidden />}
            {p.improving ? 'Improving…' : 'Improve'}
          </button>
          <span className="flex items-center gap-2">
            <span className="hidden text-2xs text-dust-2 md:inline">
              {p.ghost ? 'Tab to use the suggestion · ' : ''}
              {running && onStop && !steerable ? 'Enter to queue' : 'Enter to send'} · / for commands · ? for shortcuts
            </span>
            {running && onStop ? (
              <>
                <Button size="sm" variant="ghost" onClick={onStop} aria-label="Stop the agent" title="Stop (Esc)">
                  <Square className="size-3 fill-current" /> Stop
                </Button>
                <Button size="sm" onClick={() => p.submit(true)} disabled={empty || sending} title="Interrupt the agent and send this right away (Ctrl+Enter)">
                  <Zap className="size-3.5" /> Send now
                </Button>
                {steerable ? (
                  <Button size="sm" variant="primary" onClick={() => p.submit(false)} disabled={empty || sending} title="The agent reads it at its next step, without stopping">
                    {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-3.5" />} Send
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => p.submit(false)} disabled={empty || sending} title="Send when the agent finishes">
                    {sending ? <Loader2 className="size-4 animate-spin" /> : <Clock3 className="size-3.5" />} Queue
                  </Button>
                )}
              </>
            ) : (
              <Button size="icon" variant="primary" onClick={() => p.submit(false)} disabled={empty || sending || running} aria-label="Send">
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
  const out = step.output ?? null;
  if (step.kind === 'note') return <li className="px-2 py-0.5 text-xs text-dust">{step.object}</li>;
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
        {out?.diff?.length ? (
          <span className="shrink-0 text-2xs tabular">
            <span className="text-go">+{out.added ?? 0}</span> <span className="text-fault">−{out.removed ?? 0}</span>
          </span>
        ) : null}
        {step.detail && !blocked && step.status === 'failed' ? (
          <button type="button" className="shrink-0 text-2xs text-fault hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'hide' : 'why?'}
          </button>
        ) : out?.diff?.length || out?.text ? (
          <button type="button" className="shrink-0 text-2xs text-dust hover:text-chalk hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'hide' : out?.diff?.length ? 'diff' : 'output'}
          </button>
        ) : null}
      </div>
      {open && step.status === 'failed' && step.detail ? <pre className="mono ml-6 mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-[8px] bg-hull-2 p-2 text-[12px] text-dust">{step.detail}</pre> : null}
      {open && step.status !== 'failed' && out?.diff?.length ? (
        <div className="mono ml-6 mt-1 max-h-72 overflow-auto rounded-[8px] border border-seam text-[12px] leading-5">
          {out.diff.map((l, i) => (
            <div key={i} className={cn('whitespace-pre-wrap break-all px-2', l[0] === '+' ? 'bg-[#e6ffec] text-[#1a7f37]' : l[0] === '-' ? 'bg-[#ffebe9] text-[#b42318]' : 'text-dust')}>
              {l[0] === '+' || l[0] === '-' ? l[0] : ' '} {l.slice(1)}
            </div>
          ))}
          {(out.lines ?? 0) > out.diff.length ? <div className="px-2 text-dust-2">… {out.lines! - out.diff.length} more lines</div> : null}
        </div>
      ) : null}
      {open && step.status !== 'failed' && !out?.diff?.length && out?.text ? (
        <pre className="mono ml-6 mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-[8px] bg-hull-2 p-2 text-[12px] text-dust">
          {out.text}
          {(out.lines ?? 0) > out.text.split('\n').length ? `\n… ${out.lines! - out.text.split('\n').length} more lines` : ''}
        </pre>
      ) : null}
    </li>
  );
}

/** The images you attached, as thumbnails that open full size. */
function Thumbs({ attachments, small }: { attachments: ChatMessageDTO['attachments']; small?: boolean }) {
  if (!attachments.length) return null;
  return (
    <span className={cn('flex flex-wrap justify-end gap-2', small ? 'mt-1.5' : 'mt-2')}>
      {attachments.map((a, i) => (
        <a key={a.id} href={a.url} target="_blank" rel="noreferrer" title={`Image #${i + 1}: ${a.name}`}>
          <img src={a.url} alt={`Image #${i + 1}`} loading="lazy" className={cn('block rounded-[10px] border border-seam object-cover', small ? 'max-h-20 max-w-[140px]' : 'max-h-40 max-w-[220px]')} />
        </a>
      ))}
    </span>
  );
}

/** A long message (a pasted log or file) shows its start, with the rest one click away. */
function FoldedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  if (open || (lines.length <= 12 && text.length <= 1500)) return <>{text}</>;
  const head = lines.slice(0, 8).join('\n').slice(0, 1200);
  return (
    <>
      {head}
      {'\n'}
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-[600] text-telemetry hover:underline">
        … show all {lines.length} lines
      </button>
    </>
  );
}

const SHOW_LAST = 6;

function AgentTurn({ msg, events, seat, isLast, allowed, onAllow, onAllowAll, onRetry, folder, steered }: {
  /** Messages you sent while this answer was running; shown where they arrived. */
  steered: ChatMessageDTO[];
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
  const items = runs.flatMap((r) => r.steps).filter((s) => !(s.kind === 'say' && (s.detail ?? '').trim() === final));
  const toolCount = items.filter((s) => s.kind !== 'say').length;
  type Line = { key: string; ts: string; step?: LiveStep; you?: ChatMessageDTO };
  const lines: Line[] = [...items.map((s) => ({ key: `s${s.id}`, ts: s.ts, step: s })), ...steered.map((m) => ({ key: m.id, ts: m.createdAt, you: m }))].sort((a, b) => a.ts.localeCompare(b.ts));
  // The agent's first message after one of yours is its reply to you.
  const replies = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.you) continue;
    const reply = lines.slice(i + 1).find((l) => l.you || l.step?.kind === 'say');
    if (reply?.step) replies.add(reply.key);
  }
  const cut = !showAll && lines.length > SHOW_LAST + 2 ? lines.length - SHOW_LAST : 0;
  // Your own messages and the replies to them stay visible even when earlier steps are folded away.
  const keep = (l: Line) => !!l.you || replies.has(l.key);
  const shown = cut ? [...lines.slice(0, cut).filter(keep), ...lines.slice(cut)] : lines;
  const hidden = cut ? lines.slice(0, cut).filter((l) => !keep(l)).length : 0;
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

      {lines.length || running ? (
        <ol className="mt-2 space-y-0.5 border-l-2 border-seam pl-2.5" aria-label={`What ${who.name} did`}>
          {hidden ? (
            <li>
              <button type="button" onClick={() => setShowAll(true)} className="rounded-[8px] px-2 py-1 text-xs text-dust hover:bg-hull-2 hover:text-chalk">
                Show {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
              </button>
            </li>
          ) : null}
          {shown.map(({ key, step: s, you }) =>
            you ? (
              <li key={key} className="my-1 flex justify-end">
                <span className="max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-br-[4px] bg-hull-3 px-3 py-1.5 text-sm leading-6 text-chalk">
                  <span className="mr-1.5 text-2xs font-[650] text-dust">You</span>
                  {you.content}
                  <Thumbs attachments={you.attachments} small />
                </span>
              </li>
            ) : s && s.kind === 'say' ? (
              replies.has(key) ? (
                <li key={key} className="my-1 rounded-[10px] border-l-2 border-telemetry bg-telemetry/[0.06] px-3 py-1.5 text-sm leading-6 text-chalk">
                  <span className="mr-1.5 text-2xs font-[650] text-telemetry">Reply to you</span>
                  {s.detail ?? s.object}
                </li>
              ) : (
                <li key={key} className="px-2 py-1 text-sm leading-6 text-chalk/85">
                  {s.detail ?? s.object}
                </li>
              )
            ) : s ? (
              <StepLine key={key} step={s} folder={folder} />
            ) : null,
          )}
          {running && !lines.length ? (
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

function Transcript({
  chat,
  folder,
  onAllow,
  onAllowAll,
  onRetry,
  onUnqueue,
  compact,
}: {
  chat: ConversationDetailDTO;
  folder: string;
  compact?: boolean;
  onAllow: (c: string) => void;
  onAllowAll: () => void;
  onRetry: (q: string) => void;
  onUnqueue: (messageId: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  const byMessage = useMemo(() => {
    const map = new Map<string, ChatEventDTO[]>();
    for (const e of chat.events) map.set(e.messageId, [...(map.get(e.messageId) ?? []), e]);
    return map;
  }, [chat.events]);
  const lastAgent = [...chat.messages].reverse().find((m) => m.role === 'assistant')?.id;
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
      className={cn('min-h-0 flex-1 overflow-y-auto', compact ? 'px-4 py-4' : 'px-5 py-6 sm:px-8')}
    >
      <div className={cn('mx-auto max-w-[760px]', compact ? 'space-y-5' : 'space-y-7')}>
        {chat.messages.map((m, i) =>
          m.role === 'user' && m.status === 'steered' ? null : m.role === 'user' ? (
            <div key={m.id} className="flex flex-col items-end gap-1">
              <div
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-[18px] rounded-br-[6px] px-4 py-2.5 text-[14.5px] leading-6',
                  m.status === 'queued' ? 'border border-dashed border-seam-2 bg-hull text-chalk/80' : m.status === 'cancelled' ? 'bg-hull-2 text-dust line-through' : 'bg-hull-3 text-chalk',
                )}
              >
                <FoldedText text={m.content} />
                <Thumbs attachments={m.attachments} />
              </div>
              {m.status === 'queued' ? (
                <span className="flex items-center gap-1.5 text-2xs text-dust">
                  <Clock3 className="size-3" aria-hidden /> Queued, sends when the agent finishes
                  <button type="button" onClick={() => onUnqueue(m.id)} className="grid size-5 place-items-center rounded-[6px] hover:bg-hull-2 hover:text-chalk" aria-label="Remove this queued message" title="Remove">
                    <X className="size-3" />
                  </button>
                </span>
              ) : m.status === 'cancelled' && m.error ? (
                <span className="text-2xs text-dust">{m.error}</span>
              ) : null}
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
              steered={steeredBy.get(m.id) ?? []}
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

function SessionsMenu({ repo, tab, current, compact }: { repo: RepoDTO; tab: WorkspaceTab; current: string | null; compact?: boolean }) {
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
      {compact ? (
        <Button size="icon" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Sessions in ${repo.name}`} title="Other sessions in this project">
          <History className="size-4" />
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          <History className="size-3.5" /> Sessions
          <ChevronDown className="size-3" />
        </Button>
      )}
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
  model,
  onModel,
  effort,
  onEffort,
  children,
  trailing,
  compact,
  onExpand,
}: {
  repo: RepoDTO;
  tab: WorkspaceTab;
  chat: ConversationDetailDTO | null;
  compact?: boolean;
  onExpand?: () => void;
  provider: Provider;
  onProvider: (p: Provider) => void;
  model?: string | null;
  onModel?: (m: string | null) => void;
  effort?: EffortLevel | null;
  onEffort?: (e: EffortLevel | null) => void;
  children?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const security = chat?.seat === 'security';
  const controls = (
    <>
      {children}
      {!security ? <ProviderSwitch value={provider} onChange={onProvider} /> : null}
      {!security && onModel ? <ModelPicker provider={provider} value={model ?? null} onChange={onModel} /> : null}
      {!security && onEffort ? <EffortPicker value={effort ?? null} onChange={onEffort} /> : null}
    </>
  );
  if (compact) {
    const setup = [provider === 'auto' ? 'Auto' : PROVIDER_NAME[provider], model ? (modelLabel(model) ?? model).replace(/^Claude /, '') : null, effort ? `${EFFORT_INFO[effort].label} effort` : null].filter(Boolean).join(', ');
    return (
      <div className="border-b border-seam">
        <div className="flex items-center gap-1 py-1.5 pl-7 pr-1.5">
          <div className="min-w-0 flex-1">
            <h2 className="casual truncate text-base font-[700] leading-5">{security ? `Security check of ${repo.name}` : repo.name}</h2>
            <p className="truncate text-2xs text-dust" title={repo.localPath}>
              {chat?.title ?? 'New session'}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(!settingsOpen)} aria-expanded={settingsOpen} title="AI, model, effort and commands for this session" className={cn(settingsOpen && 'bg-hull-2')}>
            <SlidersHorizontal className="size-3.5" />
            <span className="max-w-[150px] truncate">{setup}</span>
          </Button>
          <SessionsMenu repo={repo} tab={tab} current={chat?.id ?? null} compact />
          {trailing}
          {onExpand ? (
            <Button size="icon" variant="ghost" onClick={onExpand} aria-label={`Open ${repo.name} full size`} title="Full size">
              <Maximize2 className="size-4" />
            </Button>
          ) : null}
          <Button size="icon" variant="ghost" onClick={() => tabs.close(tab.key)} aria-label={`Close ${repo.name}`} title="Close this pane (the session is kept)">
            <X className="size-4" />
          </Button>
        </div>
        {settingsOpen ? <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-seam bg-night px-4 py-2">{controls}</div> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-seam px-5 py-3">
      <div className="w-full min-w-0 sm:w-auto sm:flex-1">
        <h2 className="casual truncate text-lg font-[700] leading-6">{chat?.seat === 'security' ? `Security check of ${repo.name}` : repo.name}</h2>
        <p className="mono truncate text-2xs text-dust" title={repo.localPath}>
          {repo.localPath}
        </p>
      </div>
      {controls}
      <SessionsMenu repo={repo} tab={tab} current={chat?.id ?? null} />
      {trailing}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A tab: a new session, or a running one
// ---------------------------------------------------------------------------

export const STARTERS = [
  { label: 'Explain this project', text: 'Give me a short tour of this project: what it does, how it is organised, and where the important code lives.' },
  { label: 'Find and fix a bug', text: 'Look for the most likely bug in this project, explain it, and fix it with a test.' },
  { label: 'Add missing tests', text: 'Find important logic that has no tests and add focused tests for it.' },
  { label: 'Polish the UI', text: 'Review the user interface of this project and improve the weakest screen, keeping the existing style. Use the design skill that fits this project.' },
];

interface PaneProps {
  /** Shown as one pane of several, side by side. */
  compact?: boolean;
  onExpand?: () => void;
}

function NewSession({ repo, tab, compact, onExpand }: { repo: RepoDTO; tab: WorkspaceTab } & PaneProps) {
  const navigate = useNavigate();
  const canEdit = repo.allowModify && repo.isGit;
  const agents = useAgents();
  const settings = useSettings();
  const [draft, setDraft] = useState('');
  const [provider, setProvider] = useState<Provider>('auto');
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<EffortLevel | null>(null);
  const [mode, setMode] = useState<SessionMode>(canEdit ? 'edit' : 'ask');
  const [commands, setCommands] = useState<SessionPermissionMode | null>(null);
  const permissionMode = commands ?? settings.data?.execution.sessionCommands ?? 'ask';
  const start = useAction(
    (v: { message: string; images: ChatImageInput[] }) =>
      post<ConversationDetailDTO>('/api/chats', { message: v.message, ...(v.images.length ? { images: v.images } : {}), repoIds: [repo.id], mode, provider, permissionMode, model, effort }),
    { invalidate: [keys.chats] },
  );
  const actions = useRepoActions(repo, tab);
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const seat = agents.data?.find((a) => a.role === 'assistant');
  const autoName = seat?.resolved.provider ? PROVIDER_NAME[seat.resolved.provider] : 'the AI';
  const who = provider === 'auto' ? autoName : PROVIDER_NAME[provider];
  const prompt: PromptOptions = {
    repo,
    sessionId: null,
    canEdit,
    security: false,
    value: draft,
    onChange: setDraft,
    mode: promptMode(mode, permissionMode),
    onMode: (m) => {
      const next = modePatch(m);
      setMode(next.mode);
      if (next.permissionMode) setCommands(next.permissionMode);
    },
    provider,
    onProvider: (p) => {
      setProvider(p);
      setModel(null);
    },
    model,
    onModel: setModel,
    effort,
    onEffort: setEffort,
    running: false,
    sending: start.isPending,
    onSubmit: (message, images, _now, done) =>
      start.mutate(
        { message, images },
        {
          onSuccess: (c) => {
            done();
            tabs.attach(tab.key, c.id);
            navigate(`/s/${c.id}`);
          },
        },
      ),
    commands: {
      clear: () => setDraft(''),
      open: actions.open,
      ...(canEdit ? { commit: (m: string) => actions.commit(m, () => undefined), security: actions.security } : {}),
      close: () => tabs.close(tab.key),
      ...(onExpand ? { expand: onExpand } : {}),
    },
    history: [],
    menu,
    setMenu,
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        repo={repo}
        tab={tab}
        chat={null}
        provider={provider}
        onProvider={(p) => {
          setProvider(p);
          setModel(null);
        }}
        model={model}
        onModel={setModel}
        effort={effort}
        onEffort={setEffort}
        compact={compact}
        onExpand={onExpand}
      />
      <div className={cn('flex flex-1 flex-col justify-center overflow-y-auto', compact ? 'px-4 py-5' : 'px-5 py-10')}>
        <div className="mx-auto w-full max-w-[680px]">
          <h1 className={compact ? 'text-xl leading-7' : 'text-[28px] leading-9'}>What should we do in {repo.name}?</h1>
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
            <Composer prompt={prompt} placeholder={mode === 'edit' ? `Tell ${who} what to change…` : `Ask ${who} about ${repo.name}…`} big={!compact} autoFocus={!compact} />
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

function RunningSession({ repo, tab, sessionId, compact, onExpand }: { repo: RepoDTO; tab: WorkspaceTab; sessionId: string } & PaneProps) {
  const navigate = useNavigate();
  const chat = useChat(sessionId);
  const [draft, setDraft] = useState('');
  const [showChanges, setShowChanges] = useState(false);
  const invalidate = [keys.chats, keys.chat(sessionId)];
  const send = useAction((v: { message: string; now?: boolean; images?: ChatImageInput[] }) => post<ConversationDetailDTO>(`/api/chats/${sessionId}/messages`, v), { invalidate });
  const unqueue = useAction((messageId: string) => del<ConversationDetailDTO>(`/api/chats/${sessionId}/messages/${messageId}`), { invalidate });
  const stop = useAction(() => post(`/api/chats/${sessionId}/cancel`), { invalidate });
  // A model belongs to one AI, so switching AI goes back to that AI's default model.
  const setProvider = useAction((provider: Provider) => patch(`/api/chats/${sessionId}`, { provider, model: null }), { invalidate });
  const setModel = useAction((model: string | null) => patch(`/api/chats/${sessionId}`, { model }), { invalidate });
  const setEffort = useAction((effort: EffortLevel | null) => patch(`/api/chats/${sessionId}`, { effort }), { invalidate });
  const allow = useAction((command: string) => post<ConversationDetailDTO>(`/api/chats/${sessionId}/allow`, { command }), { invalidate });
  const allowAll = useAction(() => post<ConversationDetailDTO>(`/api/chats/${sessionId}/allow-all`), { invalidate });
  const approve = useAction((decision: 'accept' | 'acceptForSession' | 'decline') => post<ConversationDetailDTO>(`/api/chats/${sessionId}/approval`, { decision }), { invalidate });
  const setCommands = useAction((permissionMode: SessionPermissionMode) => patch(`/api/chats/${sessionId}`, { permissionMode }), {
    success: (r) => ((r as ConversationSummaryDTO).permissionMode === 'auto' ? 'Auto-accept on: commands run on their own, risky ones are still blocked' : 'Ask first: the agent asks before running commands'),
    invalidate,
  });
  const remove = useAction(() => del(`/api/chats/${sessionId}`), { success: 'Session deleted', invalidate: [keys.chats] });
  const setMode = useAction((m: PromptMode) => patch(`/api/chats/${sessionId}`, modePatch(m)), { invalidate });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const actions = useRepoActions(repo, tab);

  if (chat.isPending) return <Loading label="Opening the session" />;
  if (chat.error || !chat.data) return <div className="p-6"><ErrorNote error={chat.error} /></div>;
  const c = chat.data;
  const running = c.messages.some((m) => m.status === 'running');
  const editing = c.mode === 'edit';
  const editEvents = c.events.filter((e) => e.kind === 'tool' && (e.data as { step?: string } | null)?.step === 'edit').length;
  const who = c.provider === 'auto' ? 'the agent' : PROVIDER_NAME[c.provider];
  const submit = (text = draft, now = false) => text.trim() && send.mutate({ message: text.trim(), now }, { onSuccess: () => setDraft('') });
  const canEdit = repo.allowModify && repo.isGit;
  const prompt: PromptOptions = {
    repo,
    sessionId,
    canEdit,
    security: c.seat === 'security',
    value: draft,
    onChange: setDraft,
    mode: promptMode(c.mode, c.permissionMode),
    onMode: (m) => setMode.mutate(m),
    provider: c.provider,
    onProvider: (p) => setProvider.mutate(p),
    model: c.model,
    onModel: (m) => setModel.mutate(m),
    effort: c.effort,
    onEffort: (e) => setEffort.mutate(e),
    running,
    sending: send.isPending || allow.isPending || allowAll.isPending,
    onSubmit: (message, images, now, done) => send.mutate({ message, now, ...(images.length ? { images } : {}) }, { onSuccess: done }),
    onStop: () => stop.mutate(undefined),
    commands: {
      clear: actions.clear,
      open: actions.open,
      ...(editing ? { changes: () => setShowChanges(true), commit: (m: string) => actions.commit(m, () => setShowChanges(true)), security: actions.security } : {}),
      close: () => {
        tabs.close(tab.key);
        navigate('/');
      },
      ...(onExpand ? { expand: onExpand } : {}),
      remove: () =>
        remove.mutate(undefined, {
          onSuccess: () => {
            tabs.close(tab.key);
            navigate('/');
          },
        }),
    },
    history: c.messages.filter((m) => m.role === 'user').map((m) => m.content).reverse(),
    menu,
    setMenu,
    suggestion: c.nextPrompt,
  };
  const changesButton = editing ? (
    <Button size="sm" variant="ghost" className={cn(!compact && 'xl:hidden', showChanges && 'bg-hull-2')} onClick={() => setShowChanges(!showChanges)} aria-expanded={showChanges}>
      Changes
    </Button>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col bg-hull">
        <Header
          repo={repo}
          tab={tab}
          chat={c}
          provider={c.provider}
          onProvider={(p) => setProvider.mutate(p)}
          model={c.model}
          onModel={(m) => setModel.mutate(m)}
          effort={c.effort}
          onEffort={(e) => setEffort.mutate(e)}
          compact={compact}
          onExpand={onExpand}
          trailing={
            compact ? (
              changesButton
            ) : confirmDelete ? (
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
            compact ? null : changesButton
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
          onUnqueue={(id) => unqueue.mutate(id)}
          compact={compact}
        />
        {c.approval ? <ApprovalCard approval={c.approval} who={who ?? 'the agent'} busy={approve.isPending} onAnswer={(d) => approve.mutate(d)} /> : null}
        <div className={cn('border-t border-seam bg-hull', compact ? 'px-3 py-2.5' : 'px-5 py-3 sm:px-8')}>
          <div className="mx-auto max-w-[760px]">
            <Composer
              prompt={prompt}
              steerable={c.steerable}
              placeholder={
                running
                  ? c.steerable
                    ? `Type a follow-up. ${who === 'the agent' ? 'The agent' : who} reads it at its next step, without stopping.`
                    : `Type a follow-up. It is sent when ${who} finishes, or click Send now to interrupt.`
                  : editing
                    ? 'What next?'
                    : 'Ask a follow-up…'
              }
              autoFocus={!compact}
            />
          </div>
        </div>
      </section>
      {editing ? <ChangesPanel repo={repo} running={running} editEvents={editEvents} open={showChanges} onClose={() => setShowChanges(false)} docked={!compact} /> : null}
    </div>
  );
}

/** The agent is waiting, mid-answer, for your OK to run something its sandbox blocks (Codex). */
function ApprovalCard({ approval, who, busy, onAnswer }: { approval: SessionApprovalDTO; who: string; busy: boolean; onAnswer: (d: 'accept' | 'acceptForSession' | 'decline') => void }) {
  return (
    <div className="border-t border-signal/50 bg-signal/[0.08] px-5 py-3 sm:px-8" role="alert">
      <div className="mx-auto max-w-[760px]">
        <p className="text-sm font-[650] text-chalk">
          {who === 'the agent' ? 'The agent' : who} wants to {approval.kind === 'command' ? 'run a command' : 'change files'} outside its sandbox
        </p>
        {approval.command ? <pre className="mono mt-2 overflow-x-auto whitespace-pre-wrap rounded-[8px] bg-hull px-3 py-2 text-[13px] text-chalk">{approval.command}</pre> : null}
        {approval.reason ? <p className="mt-1.5 text-xs text-dust">{approval.reason}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={busy} onClick={() => onAnswer('accept')}>
            Allow
          </Button>
          <Button size="sm" onClick={() => onAnswer('acceptForSession')} title="Similar requests in this session run without asking">
            Allow for this session
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAnswer('decline')}>
            Don&apos;t allow
          </Button>
        </div>
      </div>
    </div>
  );
}

export function TabView({ tab, repo, compact, onExpand }: { tab: WorkspaceTab; repo: RepoDTO } & PaneProps) {
  return tab.sessionId ? (
    <RunningSession key={tab.sessionId} repo={repo} tab={tab} sessionId={tab.sessionId} compact={compact} onExpand={onExpand} />
  ) : (
    <NewSession key={tab.key} repo={repo} tab={tab} compact={compact} onExpand={onExpand} />
  );
}

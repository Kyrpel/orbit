import {
  ArrowDown,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  CircleSlash,
  FilePen,
  FileText,
  Globe,
  Info,
  ListChecks,
  Loader2,
  MessageSquare,
  Search,
  ShieldAlert,
  Split,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration, MISSION_STATE_META, type AgentPlanItem, type MissionEventDTO, type MissionState } from '@orbit/shared';
import { buildLiveModel, type CheckStatus, type LiveBlock, type LiveChecks, type LiveNow, type LiveRun, type LiveStep, type LiveStepKind, type RunOutcome, type StepStatus } from '../lib/live-steps';
import { clockTime, cn } from '../lib/utils';
import { Empty } from './ui';

export const ROLE_NAME: Record<string, string> = { planner: 'Planner', engineer: 'Engineer', reviewer: 'Reviewer', security: 'Security reviewer', prompter: 'Prompt engineer', assistant: 'Session agent', system: 'Orbit' };

export const KIND_ICON: Record<LiveStepKind | 'check' | 'starting', LucideIcon> = {
  read: FileText,
  edit: FilePen,
  search: Search,
  run: SquareTerminal,
  web: Globe,
  plan: ListChecks,
  delegate: Split,
  other: Wrench,
  say: MessageSquare,
  blocked: ShieldAlert,
  note: Info,
  check: ListChecks,
  starting: Loader2,
};

/** Re-renders every second while `active`, for elapsed-time counters. */
export function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function since(iso: string, now: number): string {
  return formatDuration(Math.max(0, now - Date.parse(iso)));
}

function StatusMark({ status }: { status: StepStatus | CheckStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3.5 animate-spin text-telemetry" aria-label="In progress" />;
    case 'done':
    case 'passed':
      return <Check className="size-3.5 text-go" aria-label="Done" />;
    case 'stopped':
      return <CircleSlash className="size-3.5 text-dust-2" aria-label="Interrupted" />;
    default:
      return <X className="size-3.5 text-fault" aria-label="Failed" />;
  }
}

// ---------------------------------------------------------------------------
// "Now" banner
// ---------------------------------------------------------------------------

function NowBanner({ now, status, tick }: { now: LiveNow | null; status: MissionState; tick: number }) {
  const meta = MISSION_STATE_META[status];
  if (!now) {
    const tone = meta.tone === 'attention' ? 'text-signal-deep' : meta.tone === 'danger' ? 'text-fault' : meta.tone === 'success' ? 'text-go' : 'text-dust';
    return (
      <div className="flex items-start gap-3 border-b border-seam px-5 py-4" aria-live="polite">
        <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full bg-current', tone)} aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-[600]">{meta.label}</p>
          <p className="text-xs text-dust">{meta.description}</p>
        </div>
      </div>
    );
  }
  const Icon = KIND_ICON[now.kind];
  return (
    <div className="border-b border-seam bg-telemetry/[0.04] px-5 py-4" aria-live="polite">
      <div className="flex items-start gap-3">
        <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-current text-telemetry animate-beacon" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-[600] text-telemetry">{ROLE_NAME[now.actor] ?? now.actor} is working now</p>
          <p className="mt-1 flex min-w-0 items-center gap-2 text-base font-[600]">
            <Icon className={cn('size-4 shrink-0 text-dust', now.kind === 'starting' && 'animate-spin')} aria-hidden />
            <span className="shrink-0">{now.verb}</span>
            {now.object ? <span className="mono min-w-0 truncate text-sm font-normal text-chalk/85" title={now.object}>{now.object}</span> : null}
          </p>
          {now.focus ? (
            <p className="mt-1 text-xs text-dust">
              Working on: <span className="text-chalk/85">{now.focus}</span>
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-2xs text-dust tabular">
          <p title="Time on this step">{since(now.since, tick)}</p>
          <p className="text-dust-2" title="Time since this agent started">{since(now.runStartedAt, tick)} total</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export function Plan({ items }: { items: AgentPlanItem[] }) {
  const done = items.filter((i) => i.status === 'completed').length;
  return (
    <div className="mx-5 mb-2 rounded-[8px] border border-seam bg-night/60 px-3 py-2">
      <p className="mb-1.5 flex items-center justify-between text-2xs text-dust">
        <span className="inline-flex items-center gap-1.5">
          <ListChecks className="size-3.5" aria-hidden /> Agent's to-do list
        </span>
        <span className="tabular">
          {done}/{items.length} done
        </span>
      </p>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            {it.status === 'completed' ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-go" aria-label="Done" />
            ) : it.status === 'in_progress' ? (
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-telemetry" aria-label="In progress" />
            ) : (
              <Circle className="mt-0.5 size-3.5 shrink-0 text-dust-2" aria-label="Not started" />
            )}
            <span className={cn(it.status === 'completed' ? 'text-dust line-through decoration-dust-2/60' : it.status === 'in_progress' ? 'text-chalk' : 'text-chalk/75')}>{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StepRow({ step }: { step: LiveStep }) {
  const Icon = KIND_ICON[step.kind];
  const [open, setOpen] = useState(false);
  if (step.kind === 'say') {
    const long = (step.detail ?? '').length > step.object.length + 20;
    return (
      <li className="grid grid-cols-[18px_minmax(0,1fr)_88px] gap-3 px-5 py-1.5">
        <Icon className="mt-1 size-3.5 text-dust-2" aria-hidden />
        <div className="min-w-0 border-l-2 border-seam-2 pl-3 text-sm text-chalk/85">
          <p className={cn('whitespace-pre-wrap leading-6', !open && 'line-clamp-3')}>{open ? step.detail : step.object}</p>
          {long ? (
            <button type="button" className="text-2xs text-dust hover:text-chalk" onClick={() => setOpen(!open)}>
              {open ? 'Show less' : 'Show full message'}
            </button>
          ) : null}
        </div>
        <span className="whitespace-nowrap text-right text-2xs leading-6 text-dust-2 tabular">{clockTime(step.ts)}</span>
      </li>
    );
  }
  const verb = step.status === 'running' ? step.verb.doing : step.verb.done;
  return (
    <li className={cn('px-5 py-1', step.status === 'running' && 'bg-telemetry/[0.05]')}>
      <div className="grid grid-cols-[18px_minmax(0,1fr)_88px] items-center gap-3">
        <Icon className={cn('size-3.5', step.status === 'running' ? 'text-telemetry' : 'text-dust')} aria-hidden />
        <div className="flex min-w-0 items-center gap-2 text-sm leading-6">
          <StatusMark status={step.status} />
          {verb ? <span className={cn('shrink-0', step.status === 'running' ? 'text-chalk' : 'text-chalk/85')}>{verb}</span> : null}
          <span className={cn('min-w-0 truncate', step.kind === 'note' ? 'text-dust' : 'mono text-xs text-dust')} title={step.object}>
            {step.object}
          </span>
          {step.detail ? (
            <button type="button" className="shrink-0 text-2xs text-fault hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'hide output' : 'show output'}
            </button>
          ) : null}
        </div>
        <span className="whitespace-nowrap text-right text-2xs text-dust-2 tabular">{clockTime(step.ts)}</span>
      </div>
      {open && step.detail ? <pre className="mono mb-1 ml-[30px] mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-[6px] bg-night p-2 text-[12px] text-dust">{step.detail}</pre> : null}
    </li>
  );
}

const OUTCOME: Record<RunOutcome, { label: string; className: string }> = {
  running: { label: 'working', className: 'text-telemetry' },
  succeeded: { label: 'finished', className: 'text-go' },
  failed: { label: 'stopped with an error', className: 'text-fault' },
  cancelled: { label: 'cancelled', className: 'text-dust' },
  stopped: { label: 'interrupted', className: 'text-dust' },
};

function RunBlock({ run, defaultOpen, tick }: { run: LiveRun; defaultOpen: boolean; tick: number }) {
  const [open, setOpen] = useState(defaultOpen);
  // Follow the newest run: open it when it starts, collapse older ones once they finish.
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const running = run.outcome === 'running';
  const elapsed = run.endedAt ? formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt)) : since(run.startedAt, tick);
  const tools = run.steps.filter((s) => s.kind !== 'say' && s.kind !== 'note');
  const failed = tools.filter((s) => s.status === 'failed').length;
  const o = OUTCOME[run.outcome];
  return (
    <li className="border-b border-seam last:border-b-0">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-hull-2/50">
        <ChevronRight className={cn('size-4 shrink-0 text-dust transition-transform', open && 'rotate-90')} aria-hidden />
        <span className="font-[600]">{ROLE_NAME[run.role]}</span>
        <span className={cn('text-xs', o.className)}>{o.label}</span>
        {run.model ? <span className="mono hidden truncate text-2xs text-dust-2 sm:inline">{run.model}</span> : null}
        <span className="ml-auto shrink-0 text-2xs text-dust tabular">
          {tools.length} {tools.length === 1 ? 'step' : 'steps'}
          {failed ? <span className="text-fault"> · {failed} failed</span> : null} · {elapsed}
        </span>
      </button>
      {open ? (
        <div className="pb-3">
          {run.plan?.length ? <Plan items={run.plan} /> : null}
          {run.steps.length ? (
            <ol>
              {run.steps.map((s) => (
                <StepRow key={s.id} step={s} />
              ))}
            </ol>
          ) : (
            <p className="px-5 py-1 text-sm text-dust">{running ? 'Starting up…' : 'No steps recorded.'}</p>
          )}
          {run.endTitle && run.outcome !== 'succeeded' ? <p className="mx-5 mt-2 text-xs text-fault">{run.endTitle}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

function ChecksBlock({ block, tick }: { block: LiveChecks; tick: number }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const passed = block.items.filter((i) => i.status === 'passed').length;
  return (
    <li className="border-b border-seam py-3 last:border-b-0">
      <p className="flex items-center gap-3 px-5 pb-1.5">
        <ListChecks className="size-4 text-dust" aria-hidden />
        <span className="font-[600]">Your checks</span>
        <span className="text-xs text-dust">run by Orbit</span>
        <span className="ml-auto text-2xs text-dust tabular">
          {passed}/{block.items.length} passed
        </span>
      </p>
      <ol>
        {block.items.map((c) => (
          <li key={c.id} className="px-5 py-1">
            <div className="grid grid-cols-[18px_minmax(0,1fr)_88px] items-center gap-3">
              <StatusMark status={c.status} />
              <div className="flex min-w-0 items-center gap-2 text-sm leading-6">
                <span className="shrink-0">{c.label}</span>
                <span className="mono min-w-0 truncate text-xs text-dust" title={c.command}>
                  {c.command}
                </span>
                {c.detail ? (
                  <button type="button" className="shrink-0 text-2xs text-fault hover:underline" onClick={() => setOpenId(openId === c.id ? null : c.id)} aria-expanded={openId === c.id}>
                    {openId === c.id ? 'hide output' : 'show output'}
                  </button>
                ) : null}
              </div>
              <span className="whitespace-nowrap text-right text-2xs text-dust-2 tabular">{c.endedAt ? formatDuration(Date.parse(c.endedAt) - Date.parse(c.startedAt)) : c.status === 'running' ? since(c.startedAt, tick) : ''}</span>
            </div>
            {openId === c.id && c.detail ? <pre className="mono mb-1 ml-[30px] mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-[6px] bg-night p-2 text-[12px] text-dust">{c.detail}</pre> : null}
          </li>
        ))}
      </ol>
    </li>
  );
}

const MILESTONE_TONE = { state: 'text-chalk font-[600]', good: 'text-go', bad: 'text-fault', neutral: 'text-dust' } as const;

function Block({ block, isLastRun, tick }: { block: LiveBlock; isLastRun: boolean; tick: number }) {
  if (block.type === 'run') return <RunBlock run={block} defaultOpen={isLastRun || block.outcome === 'running'} tick={tick} />;
  if (block.type === 'checks') return <ChecksBlock block={block} tick={tick} />;
  return (
    <li className="flex items-center gap-3 border-b border-seam bg-night/40 px-5 py-2 text-xs last:border-b-0">
      <span className="text-2xs text-dust-2 tabular">{clockTime(block.ts)}</span>
      <span className={cn('min-w-0 truncate', MILESTONE_TONE[block.tone])} title={block.detail ?? block.title}>
        {block.title}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------

/** The "Live" tab: what the agents are doing right now, step by step. */
export function LiveSteps({ events, status, active }: { events: MissionEventDTO[]; status: MissionState; active: boolean }) {
  const model = useMemo(() => buildLiveModel(events, active), [events, active]);
  const tick = useTick(active);
  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  const lastRunKey = useMemo(() => [...model.blocks].reverse().find((b) => b.type === 'run')?.key, [model.blocks]);

  // Keep the newest step in view unless the user scrolled up to read.
  useEffect(() => {
    const el = box.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [events.length, following]);

  const onScroll = () => {
    const el = box.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  return (
    <div>
      <NowBanner now={model.now} status={status} tick={tick} />
      {model.blocks.length === 0 ? (
        <Empty title="Nothing has happened yet.">Steps appear here as soon as an agent starts working.</Empty>
      ) : (
        <div className="relative">
          <div ref={box} onScroll={onScroll} className="max-h-[640px] overflow-y-auto">
            <ol>
              {model.blocks.map((b) => (
                <Block key={b.key} block={b} isLastRun={b.key === lastRunKey} tick={tick} />
              ))}
            </ol>
          </div>
          {!following ? (
            <button
              type="button"
              onClick={() => setFollowing(true)}
              className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-seam-2 bg-hull-2 px-3 py-1 text-xs text-chalk shadow-lg hover:bg-hull-3"
            >
              <ArrowDown className="size-3.5" aria-hidden /> Jump to latest
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

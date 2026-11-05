import type { MissionDetailDTO, MissionState } from '@orbit/shared';
import { cn } from '../lib/utils';

/**
 * The mission trajectory: where the mission is, and which of the three human
 * gates (scope, review, publish) it is waiting at. Gates are diamonds.
 */
const STAGES = [
  { key: 'plan', label: 'Plan', gate: false },
  { key: 'scope', label: 'Scope', gate: true },
  { key: 'build', label: 'Build', gate: false },
  { key: 'verify', label: 'Verify', gate: false },
  { key: 'review', label: 'Review', gate: true },
  { key: 'publish', label: 'Publish', gate: true },
  { key: 'shipped', label: 'Shipped', gate: false },
] as const;

type Mode = 'active' | 'waiting' | 'stopped' | 'cancelled' | 'done';

export function trajectoryPosition(status: MissionState, stoppedAt = 0): { index: number; mode: Mode } {
  switch (status) {
    case 'DRAFT':
    case 'ANALYZING':
      return { index: 0, mode: 'active' };
    case 'AWAITING_SCOPE_APPROVAL':
      return { index: 1, mode: 'waiting' };
    case 'QUEUED':
    case 'RUNNING':
      return { index: 2, mode: 'active' };
    case 'VERIFYING':
      return { index: 3, mode: 'active' };
    case 'AWAITING_REVIEW':
      return { index: 4, mode: 'waiting' };
    case 'AWAITING_PR_APPROVAL':
      return { index: 5, mode: 'waiting' };
    case 'PR_CREATED':
    case 'COMPLETED':
      return { index: 6, mode: 'done' };
    case 'CANCELLED':
      return { index: stoppedAt, mode: 'cancelled' };
    default:
      return { index: stoppedAt, mode: 'stopped' };
  }
}

/** Where a blocked/failed/cancelled mission stopped, from the evidence it produced. */
export function stoppedStage(d: Pick<MissionDetailDTO, 'plan' | 'agentRuns' | 'verifications' | 'reviews' | 'missionRepos'>): number {
  if (d.missionRepos.some((r) => r.commitSha)) return 5;
  if (d.verifications.some((v) => v.kind === 'verify') || d.reviews.length) return 3;
  // A worktree exists once implementation has started (even if setup stopped it).
  if (d.agentRuns.some((r) => r.role === 'engineer') || d.missionRepos.some((r) => r.worktreePath)) return 2;
  if (d.plan) return 1;
  return 0;
}

const MODE_COLOR: Record<Mode, string> = {
  active: 'text-telemetry',
  waiting: 'text-signal-deep',
  stopped: 'text-fault',
  cancelled: 'text-dust',
  done: 'text-go',
};

function Node({ gate, state, color, beacon, small }: { gate: boolean; state: 'past' | 'current' | 'future'; color: string; beacon: boolean; small?: boolean }) {
  const size = small ? 'size-[7px]' : gate ? 'size-[11px]' : 'size-3';
  const base = cn(size, gate ? 'rotate-45 rounded-[2px]' : 'rounded-full', 'shrink-0');
  if (state === 'past') return <span className={cn(base, 'bg-chalk/70')} aria-hidden />;
  if (state === 'future') return <span className={cn(base, 'border border-seam-2 bg-night')} aria-hidden />;
  return <span className={cn(base, color, 'bg-current', beacon && 'animate-beacon')} aria-hidden />;
}

export function Trajectory({ status, stoppedAt = 0, caption, compact }: { status: MissionState; stoppedAt?: number; caption?: string | null; compact?: boolean }) {
  const { index, mode } = trajectoryPosition(status, stoppedAt);
  const color = MODE_COLOR[mode];
  const beacon = mode === 'active' || mode === 'waiting';

  if (compact) {
    return (
      <div className="flex w-[116px] shrink-0 items-center" aria-label={`Stage ${STAGES[index]?.label}`}>
        {STAGES.map((s, i) => (
          <div key={s.key} className={cn('flex items-center', i < STAGES.length - 1 && 'flex-1')}>
            <Node small gate={s.gate} state={i < index ? 'past' : i === index ? 'current' : 'future'} color={color} beacon={false} />
            {i < STAGES.length - 1 ? <span className={cn('h-px flex-1', i < index ? 'bg-chalk/45' : 'bg-seam-2')} /> : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <ol className="flex w-full items-start" aria-label="Mission progress">
      {STAGES.map((s, i) => {
        const state = i < index ? 'past' : i === index ? 'current' : 'future';
        return (
          <li key={s.key} className={cn('relative flex min-w-0 flex-col', i < STAGES.length - 1 ? 'flex-1' : 'flex-none')} aria-current={state === 'current' ? 'step' : undefined}>
            <div className="flex h-5 items-center">
              <Node gate={s.gate} state={state} color={color} beacon={beacon} />
              {i < STAGES.length - 1 ? (
                <span className={cn('mx-2 h-px flex-1', i < index ? 'bg-chalk/45' : 'bg-[repeating-linear-gradient(90deg,var(--color-seam-2)_0_4px,transparent_4px_8px)]')} />
              ) : null}
            </div>
            <div className="mt-2 pr-3">
              <p className={cn('text-xs font-[600]', state === 'current' ? color : state === 'past' ? 'text-chalk/80' : 'text-dust-2')}>
                {s.label}
                {s.gate ? <span className="sr-only"> (your decision)</span> : null}
              </p>
              {state === 'current' && caption ? <p className="mt-0.5 line-clamp-2 max-w-[22ch] text-2xs text-dust">{caption}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

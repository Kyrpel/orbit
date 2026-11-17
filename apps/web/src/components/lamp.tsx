import type { ConversationSummaryDTO } from '@orbit/shared';
import { cn } from '../lib/utils';

/*
  The status light of a project or session, the one bold element of the workspace:
  teal = an AI is working, amber = it needs you, green = finished, red = stopped.
*/

export type Lamp = 'idle' | 'new' | 'working' | 'needs' | 'done' | 'failed';

export const LAMP_LABEL: Record<Lamp, string> = {
  idle: 'No session yet',
  new: 'New session',
  working: 'Working',
  needs: 'Needs your OK',
  done: 'Finished',
  failed: 'Stopped with a problem',
};

export function lampOf(s: ConversationSummaryDTO | undefined | null): Lamp {
  if (!s) return 'new';
  if (s.running) return 'working';
  if (s.needsYou) return 'needs';
  if (s.lastStatus === 'failed') return 'failed';
  return 'done';
}

export function LampDot({ lamp, className }: { lamp: Lamp; className?: string }) {
  if (lamp === 'working') {
    return (
      <span className={cn('relative grid size-2.5 shrink-0 place-items-center', className)} role="img" aria-label={LAMP_LABEL[lamp]}>
        <span className="absolute inset-0 animate-ping rounded-full bg-telemetry/50" />
        <span className="size-2.5 rounded-full bg-telemetry" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'size-2.5 shrink-0 rounded-full',
        lamp === 'needs' && 'bg-signal',
        lamp === 'done' && 'bg-go',
        lamp === 'failed' && 'bg-fault',
        (lamp === 'new' || lamp === 'idle') && 'border-[1.5px] border-dust-2',
        className,
      )}
      role="img"
      aria-label={LAMP_LABEL[lamp]}
    />
  );
}

import { GitPullRequest } from 'lucide-react';
import { Link } from 'react-router';
import type { MissionSummaryDTO } from '@orbit/shared';
import { timeAgo } from '../lib/utils';
import { Trajectory } from './trajectory';
import { StatePill } from './ui';

const NEXT_STEP: Partial<Record<MissionSummaryDTO['status'], string>> = {
  AWAITING_SCOPE_APPROVAL: 'Confirm scope',
  AWAITING_REVIEW: 'Review changes',
  AWAITING_PR_APPROVAL: 'Approve the pull request',
  BLOCKED: 'Unblock',
  FAILED: 'Retry or cancel',
};

export function MissionRow({ m }: { m: MissionSummaryDTO }) {
  const next = NEXT_STEP[m.status];
  const pr = m.repos.find((r) => r.prUrl);
  return (
    <li className="group relative flex items-center gap-5 px-5 py-3.5 transition-colors hover:bg-hull-2/60">
      <Trajectory status={m.status} compact />
      <div className="min-w-0 flex-1">
        <Link to={`/missions/${m.id}`} className="block truncate text-sm font-[560] text-chalk after:absolute after:inset-0">
          {m.title}
        </Link>
        <p className="mt-0.5 truncate text-2xs text-dust">
          {m.source.provider === 'asana' ? `Asana${m.source.projectName ? `, ${m.source.projectName}` : ''}` : 'Local task'}
          {m.repos.length ? ` in ${m.repos.map((r) => r.name).join(', ')}` : ''}
          {m.blockedReason ? <span className="text-fault">{`. ${m.blockedReason}`}</span> : null}
        </p>
      </div>
      {next ? <span className="hidden text-xs font-[600] text-signal-deep lg:inline">{next}</span> : null}
      {pr ? (
        <a href={pr.prUrl ?? '#'} target="_blank" rel="noreferrer" className="relative z-10 hidden items-center gap-1 text-xs text-go hover:underline sm:flex">
          <GitPullRequest className="size-3.5" aria-hidden /> PR
        </a>
      ) : null}
      <span className="hidden w-16 text-right text-2xs text-dust-2 tabular sm:block">{timeAgo(m.updatedAt)}</span>
      <StatePill status={m.status} className="shrink-0" />
    </li>
  );
}

export function MissionList({ missions }: { missions: MissionSummaryDTO[] }) {
  return <ul className="divide-y divide-seam">{missions.map((m) => <MissionRow key={m.id} m={m} />)}</ul>;
}

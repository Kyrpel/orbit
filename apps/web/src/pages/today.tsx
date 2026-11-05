import { Bot, GitPullRequest, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { ExternalTaskDTO } from '@orbit/shared';
import { ImproveTaskButton } from '../components/improve-task';
import { MissionList } from '../components/mission-row';
import { NewMissionDialog } from '../components/new-mission';
import { Button, Empty, ErrorNote, Loading, PageHeader, Panel, PanelHeader } from '../components/ui';
import { keys, post, useAction, useOverview } from '../lib/api';
import { timeAgo } from '../lib/utils';

const ROLE: Record<string, string> = { planner: 'Planner', engineer: 'Engineer', reviewer: 'Reviewer', security: 'Security reviewer' };

function summary(attention: number, active: number): string {
  if (attention === 0 && active === 0) return 'Nothing is waiting for you and no Autopilot task is running.';
  const a = attention === 0 ? 'Nothing needs your decision' : attention === 1 ? 'One mission needs your decision' : `${attention} missions need your decision`;
  const b = active === 0 ? 'no agents are working' : active === 1 ? 'one mission is in flight' : `${active} missions are in flight`;
  return `${a}, and ${b}.`;
}

function SuggestionRow({ t }: { t: ExternalTaskDTO & { projectName: string } }) {
  const run = useAction(
    () =>
      post<{ taskId: string; missionId: string | null; error: string | null }[]>(`/api/projects/${t.projectId}/run`, { taskIds: [t.id] }).then((r) => {
        if (r[0]?.error) throw new Error(r[0].error);
        return r;
      }),
    { success: 'Mission created from Asana', invalidate: [keys.overview, ['missions']] },
  );
  return (
    <li className="flex items-center gap-4 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-chalk">{t.title}</p>
        <p className="truncate text-2xs text-dust">
          {t.projectName}
          {t.assignee ? `, assigned to ${t.assignee}` : ''}
        </p>
      </div>
      {t.projectId ? <ImproveTaskButton projectId={t.projectId} taskId={t.id} /> : null}
      <Button size="sm" loading={run.isPending} onClick={() => run.mutate(undefined)}>
        Run on Autopilot
      </Button>
    </li>
  );
}

export function TodayPage() {
  const overview = useOverview();
  const [creating, setCreating] = useState(false);
  if (overview.isPending) return <Loading />;
  if (overview.error) return <ErrorNote error={overview.error} />;
  const o = overview.data;

  return (
    <>
      <PageHeader
        title="Autopilot"
        description={
          <>
            Hand a whole task to your AI team: the planner plans it, the engineer builds it in a separate copy of the project, the reviewer and the security reviewer check it, and you approve before anything is committed or pushed.{' '}
            <span className="text-chalk">{summary(o.counts.attention, o.counts.activeMissions)}</span>
          </>
        }
        action={
          <>
            <Link to="/missions">
              <Button>All tasks</Button>
            </Link>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New task
            </Button>
          </>
        }
      />
      <NewMissionDialog open={creating} onOpenChange={setCreating} />

      {!o.setup.hasRepos || !o.setup.runtimeReady ? (
        <Panel className="mb-6 border-signal/40">
          <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-sm font-[600]">{!o.setup.hasRepos ? 'Connect a repository to start' : 'Your AI team is not configured yet'}</p>
              <p className="text-xs text-dust">{!o.setup.hasRepos ? 'Orbit only works on repositories you explicitly connect.' : 'Connect an AI: sign in to Claude Code or Codex, or set an Anthropic API key.'}</p>
            </div>
            <Link to={!o.setup.hasRepos ? '/setup' : '/agents'}>
              <Button variant="primary" size="sm">
                {!o.setup.hasRepos ? 'Open setup' : 'Open AI team'}
              </Button>
            </Link>
          </div>
        </Panel>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Waiting on you" description="Scope approvals, change reviews and pull requests only you can approve." />
            {o.attention.length ? <MissionList missions={o.attention} /> : <Empty title="Nothing needs you right now.">When an agent finishes or needs a decision, it shows up here first.</Empty>}
          </Panel>
          <Panel>
            <PanelHeader title="In flight" description="Missions agents are working on." />
            {o.active.length ? <MissionList missions={o.active} /> : <Empty title="No missions in flight.">Start one from a task, or post /orbit run on an Asana task.</Empty>}
          </Panel>
          {o.recent.length ? (
            <Panel>
              <PanelHeader title="Recently finished" />
              <MissionList missions={o.recent} />
            </Panel>
          ) : null}
        </div>

        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Agents at work" />
            {o.runningAgents.length ? (
              <ul className="divide-y divide-seam">
                {o.runningAgents.map((a) => (
                  <li key={a.runId} className="px-5 py-3">
                    <Link to={`/missions/${a.missionId}`} className="flex items-center gap-2 text-sm text-chalk hover:underline">
                      <Bot className="size-4 text-telemetry" aria-hidden />
                      {ROLE[a.role]} on {a.missionTitle}
                    </Link>
                    <p className="mt-1 truncate text-2xs text-dust">{a.lastEvent ?? 'Starting'}</p>
                    <p className="text-2xs text-dust-2">started {timeAgo(a.startedAt)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-5 text-sm text-dust">All agents are idle. They only run when a mission needs them.</p>
            )}
          </Panel>

          {o.suggestions.length ? (
            <Panel>
              <PanelHeader title="Ready to run" description="Open Asana tasks without a mission." />
              <ul className="divide-y divide-seam">
                {o.suggestions.map((t) => (
                  <SuggestionRow key={t.id} t={t} />
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel>
            <div className="grid grid-cols-2 divide-x divide-seam">
              <div className="px-5 py-4">
                <p className="text-2xl font-[640] tabular">{o.counts.completed7d}</p>
                <p className="text-2xs text-dust">missions finished this week</p>
              </div>
              <div className="px-5 py-4">
                <p className="flex items-center gap-2 text-2xl font-[640] tabular">
                  <GitPullRequest className="size-5 text-go" aria-hidden />
                  {o.counts.prsOpened}
                </p>
                <p className="text-2xs text-dust">pull requests opened</p>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

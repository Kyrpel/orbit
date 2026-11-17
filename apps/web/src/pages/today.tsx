import { Bot, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { ExternalTaskDTO } from '@orbit/shared';
import { ImproveTaskButton } from '../components/improve-task';
import { MissionList } from '../components/mission-row';
import { NewMissionDialog } from '../components/new-mission';
import { Button, ErrorNote, Loading, PageHeader, Panel, PanelHeader } from '../components/ui';
import { keys, post, useAction, useOverview } from '../lib/api';

const ROLE: Record<string, string> = { planner: 'Planner', engineer: 'Engineer', reviewer: 'Reviewer', security: 'Security reviewer' };

/** What happens to a task, in order. Shown while there is nothing else to show. */
const STEPS = [
  { who: 'You', what: 'describe the task in a sentence or two.' },
  { who: 'The planner', what: 'reads your project and writes a plan.' },
  { who: 'The engineer', what: 'builds it in a separate copy, so your files stay as they are.' },
  { who: 'The reviewers', what: 'run your checks and read every change.' },
  { who: 'You', what: 'look at the result and approve it, or ask for changes.' },
];

function SuggestionRow({ t }: { t: ExternalTaskDTO & { projectName: string } }) {
  const run = useAction(
    () =>
      post<{ taskId: string; missionId: string | null; error: string | null }[]>(`/api/projects/${t.projectId}/run`, { taskIds: [t.id] }).then((r) => {
        if (r[0]?.error) throw new Error(r[0].error);
        return r;
      }),
    { success: 'Task started from Asana', invalidate: [keys.overview, ['missions']] },
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
  const quiet = !o.attention.length && !o.active.length && !o.recent.length && !o.suggestions.length;
  const week = [
    o.counts.completed7d ? `${o.counts.completed7d} finished this week` : null,
    o.counts.prsOpened ? `${o.counts.prsOpened} pull ${o.counts.prsOpened === 1 ? 'request' : 'requests'} opened` : null,
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        title="Autopilot"
        description="Hand over a whole task. Your agents plan it, build it and check it, and nothing reaches your project until you approve."
        action={
          <>
            <Link to="/missions">
              <Button variant="ghost">All tasks</Button>
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
              <p className="text-sm font-[600]">{!o.setup.hasRepos ? 'Add a project to start' : 'No AI is connected yet'}</p>
              <p className="text-xs text-dust">{!o.setup.hasRepos ? 'Autopilot works in the projects you add to Orbit.' : 'Sign in to Claude Code or Codex on this computer, then come back.'}</p>
            </div>
            <Link to={!o.setup.hasRepos ? '/projects' : '/agents'}>
              <Button variant="primary" size="sm">
                {!o.setup.hasRepos ? 'Add a project' : 'Open Agents'}
              </Button>
            </Link>
          </div>
        </Panel>
      ) : null}

      {quiet ? (
        <Panel>
          <div className="px-6 py-7">
            <h2 className="text-lg">No tasks yet. Here is what happens when you start one</h2>
            <ol className="mt-4 max-w-[64ch] space-y-2.5">
              {STEPS.map((s, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-hull-3 text-2xs font-[650] tabular text-dust" aria-hidden>
                    {i + 1}
                  </span>
                  <span>
                    <span className="font-[600]">{s.who}</span> <span className="text-dust">{s.what}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-5 max-w-[64ch] text-xs text-dust">For quick questions and small edits, the Workspace is faster. Autopilot is for work you want done while you do something else.</p>
          </div>
        </Panel>
      ) : (
        <div className="space-y-6">
          {o.attention.length ? (
            <Panel className="border-signal/50">
              <PanelHeader title="Waiting for you" description="These stopped for a decision only you can make." />
              <MissionList missions={o.attention} />
            </Panel>
          ) : null}

          {o.active.length ? (
            <Panel>
              <PanelHeader title="In progress" />
              <MissionList missions={o.active} />
              {o.runningAgents.length ? (
                <ul className="border-t border-seam bg-night/40 px-5 py-3 text-xs text-dust">
                  {o.runningAgents.map((a) => (
                    <li key={a.runId} className="flex min-w-0 items-center gap-2 py-0.5">
                      <Bot className="size-3.5 shrink-0 text-telemetry" aria-hidden />
                      <Link to={`/missions/${a.missionId}`} className="shrink-0 font-[600] text-chalk hover:underline">
                        {ROLE[a.role] ?? a.role}
                      </Link>
                      <span className="truncate">{a.lastEvent ?? 'Starting'}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>
          ) : null}

          {o.suggestions.length ? (
            <Panel>
              <PanelHeader title="Ready to run" description="Open tasks from Asana that Autopilot has not started." />
              <ul className="divide-y divide-seam">
                {o.suggestions.map((t) => (
                  <SuggestionRow key={t.id} t={t} />
                ))}
              </ul>
            </Panel>
          ) : null}

          {o.recent.length ? (
            <Panel>
              <PanelHeader title="Recently finished" description={week.length ? week.join(' · ') : undefined} />
              <MissionList missions={o.recent} />
            </Panel>
          ) : null}

          {!o.attention.length && !o.active.length ? <p className="px-1 text-sm text-dust">Nothing is running and nothing is waiting for you.</p> : null}
        </div>
      )}
    </>
  );
}

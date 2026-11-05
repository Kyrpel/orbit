import { Empty, ErrorNote, Loading, PageHeader, Panel, PanelHeader } from '../components/ui';
import { useActivity } from '../lib/api';
import { timeAgo } from '../lib/utils';

export function ActivityPage() {
  const activity = useActivity();
  return (
    <>
      <PageHeader title="Activity" description="Audit log of everything Orbit and its users did: connections, triggers, approvals and published work." />
      <Panel>
        <PanelHeader title="Audit log" description="Kept locally. Secrets are redacted before anything is written." />
        {activity.isPending ? (
          <Loading />
        ) : activity.error ? (
          <div className="p-5">
            <ErrorNote error={activity.error} />
          </div>
        ) : activity.data.length ? (
          <ol className="divide-y divide-seam">
            {activity.data.map((a) => (
              <li key={a.id} className="grid grid-cols-[88px_minmax(0,1fr)] gap-4 px-5 py-2.5 text-sm md:grid-cols-[88px_180px_minmax(0,1fr)]">
                <span className="text-2xs leading-6 text-dust-2" title={new Date(a.ts).toLocaleString()}>
                  {timeAgo(a.ts)}
                </span>
                <span className="mono hidden truncate text-2xs leading-6 text-dust md:block">{a.action}</span>
                <span className="min-w-0 text-chalk/90">
                  {a.summary}
                  <span className="ml-2 text-2xs text-dust-2">{a.actor}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty title="Nothing recorded yet." />
        )}
      </Panel>
    </>
  );
}

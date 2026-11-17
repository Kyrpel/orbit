import { Empty, ErrorNote, Loading, PageHeader, Panel } from '../components/ui';
import { useActivity } from '../lib/api';
import { timeAgo } from '../lib/utils';

export function ActivityPage() {
  const activity = useActivity();
  return (
    <>
      <PageHeader title="Activity" description="A record of what Orbit did and what you approved, newest first. It stays on this computer, with passwords and keys left out." />
      <Panel>
        {activity.isPending ? (
          <Loading />
        ) : activity.error ? (
          <div className="p-5">
            <ErrorNote error={activity.error} />
          </div>
        ) : activity.data.length ? (
          <ol className="divide-y divide-seam">
            {activity.data.map((a) => (
              <li key={a.id} className="grid grid-cols-[76px_minmax(0,1fr)] gap-4 px-5 py-2.5 text-sm" title={a.action}>
                <span className="text-2xs leading-6 text-dust" title={new Date(a.ts).toLocaleString()}>
                  {timeAgo(a.ts)}
                </span>
                <span className="min-w-0 break-words text-chalk/90">
                  {a.summary}
                  {a.actor && a.actor !== 'user' ? <span className="ml-2 text-2xs text-dust">{a.actor}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty title="Nothing here yet.">Adding a project, connecting a service and every approval you give will show up here.</Empty>
        )}
      </Panel>
    </>
  );
}

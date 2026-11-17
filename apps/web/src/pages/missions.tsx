import { ArrowLeft, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { MissionList } from '../components/mission-row';
import { NewMissionDialog } from '../components/new-mission';
import { Button, Empty, ErrorNote, Loading, PageHeader, Panel, Tabs, TabsList, TabsTrigger } from '../components/ui';
import { useMissions } from '../lib/api';

type Filter = 'attention' | 'active' | 'done' | 'all';

const EMPTY: Record<Filter, { title: string; body: string }> = {
  attention: { title: 'Nothing is waiting for you.', body: 'When a task needs a decision or is ready to review, it shows up here.' },
  active: { title: 'Nothing is running.', body: 'Start one with New task, or comment /orbit run on an Asana task.' },
  done: { title: 'Nothing finished yet.', body: 'Finished and cancelled tasks are kept here with their full history.' },
  all: { title: 'No tasks yet.', body: 'Autopilot turns one task into a reviewed change. Start your first one with New task.' },
};

export function MissionsPage() {
  const [filter, setFilter] = useState<Filter>('attention');
  const [creating, setCreating] = useState(false);
  const missions = useMissions(filter);
  return (
    <>
      <Link to="/autopilot" className="mb-5 inline-flex items-center gap-1.5 text-xs text-dust hover:text-chalk">
        <ArrowLeft className="size-3.5" aria-hidden /> Autopilot
      </Link>
      <PageHeader
        title="All tasks"
        description="Everything you handed to Autopilot, with its plan, changes and checks."
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New task
          </Button>
        }
      />
      <NewMissionDialog open={creating} onOpenChange={setCreating} />
      <Panel>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            <TabsTrigger value="attention">Waiting for you</TabsTrigger>
            <TabsTrigger value="active">In progress</TabsTrigger>
            <TabsTrigger value="done">Finished</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        {missions.isPending ? (
          <Loading />
        ) : missions.error ? (
          <div className="p-5">
            <ErrorNote error={missions.error} />
          </div>
        ) : missions.data.length ? (
          <MissionList missions={missions.data} />
        ) : (
          <Empty title={EMPTY[filter].title}>{EMPTY[filter].body}</Empty>
        )}
      </Panel>
    </>
  );
}

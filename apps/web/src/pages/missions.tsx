import { Plus } from 'lucide-react';
import { useState } from 'react';
import { MissionList } from '../components/mission-row';
import { NewMissionDialog } from '../components/new-mission';
import { Button, Empty, ErrorNote, Loading, PageHeader, Panel, Tabs, TabsList, TabsTrigger } from '../components/ui';
import { useMissions } from '../lib/api';

type Filter = 'attention' | 'active' | 'done' | 'all';

const EMPTY: Record<Filter, { title: string; body: string }> = {
  attention: { title: 'Nothing needs you.', body: 'Scope approvals, reviews and pull request approvals appear here.' },
  active: { title: 'No missions in flight.', body: 'Start one with New mission, from Projects, or with /orbit run on an Asana task.' },
  done: { title: 'Nothing finished yet.', body: 'Finished, published and cancelled missions are kept here with their full history.' },
  all: { title: 'No missions yet.', body: 'A mission turns one task into a reviewed change. Start your first one.' },
};

export function MissionsPage() {
  const [filter, setFilter] = useState<Filter>('attention');
  const [creating, setCreating] = useState(false);
  const missions = useMissions(filter);
  return (
    <>
      <PageHeader
        title="Missions"
        description="Every task Orbit has worked on, with its plan, changes, checks and decisions."
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New mission
          </Button>
        }
      />
      <NewMissionDialog open={creating} onOpenChange={setCreating} />
      <Panel>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            <TabsTrigger value="attention">Needs you</TabsTrigger>
            <TabsTrigger value="active">In flight</TabsTrigger>
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

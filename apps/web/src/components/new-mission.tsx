import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { MissionSummaryDTO } from '@orbit/shared';
import { keys, post, useAction, useRepos } from '../lib/api';
import { ProjectChooser } from './project-chooser';
import { Button, Dialog, Field, Input, Textarea } from './ui';

/**
 * "Run with Orbit" for a task typed directly into Orbit (no tracker needed).
 * `initial` pre-fills it, for example from a change the Assistant proposed in Ask;
 * mount it with a fresh `key` when the initial values change.
 */
export function NewMissionDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (o: boolean) => void; initial?: { title: string; description: string; repoIds: string[] } }) {
  const repos = useRepos();
  const navigate = useNavigate();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [selected, setSelected] = useState<string[]>(initial?.repoIds ?? []);
  const modifiable = (repos.data ?? []).filter((r) => r.allowModify);
  const chosen = selected.length ? selected : modifiable.length === 1 ? [modifiable[0]!.id] : [];

  const create = useAction(
    () => post<{ mission: MissionSummaryDTO; created: boolean }>('/api/missions', { title, description, repoIds: chosen }),
    { success: 'Mission created. Orbit is planning it now.', invalidate: [['missions'], keys.overview] },
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Run with Orbit"
      description="Describe the change. Orbit plans it, implements it in an isolated worktree, runs your checks and waits for your approval before anything is pushed."
      wide
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!title.trim() || chosen.length === 0}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: (r) => {
                  onOpenChange(false);
                  setTitle('');
                  setDescription('');
                  navigate(`/missions/${r.mission.id}`);
                },
              })
            }
          >
            Start mission
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="What should change?" htmlFor="m-title">
          <Input id="m-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add rate limiting to the login endpoint" />
        </Field>
        <Field label="Details and acceptance criteria" htmlFor="m-desc" hint="The more concrete, the better the plan. Orbit treats this text as requirements, not as instructions about its own rules.">
          <Textarea id="m-desc" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={'Limit to 5 attempts per minute per IP.\nReturn 429 with a Retry-After header.\nAdd a test.'} />
        </Field>
        <Field label="Which project should this change go into?">
          {modifiable.length === 0 ? <p className="text-sm text-dust">Connect a project in Projects first.</p> : <ProjectChooser repos={modifiable} value={chosen} onChange={setSelected} />}
        </Field>
      </div>
    </Dialog>
  );
}

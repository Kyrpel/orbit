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
  const modifiable = (repos.data ?? []).filter((r) => r.allowModify && r.isGit);
  const chosen = selected.length ? selected : modifiable.length === 1 ? [modifiable[0]!.id] : [];

  const create = useAction(
    () => post<{ mission: MissionSummaryDTO; created: boolean }>('/api/missions', { title, description, repoIds: chosen }),
    { success: 'Task started. The planner is on it.', invalidate: [['missions'], keys.overview] },
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New Autopilot task"
      description="Describe the change. Your agents plan it, build it in a separate copy of the project and run your checks. Nothing reaches your project until you approve."
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
            Start task
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="What should change?" htmlFor="m-title">
          <Input id="m-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add rate limiting to the login endpoint" />
        </Field>
        <Field label="Details" htmlFor="m-desc" hint="What should be true when it is done? The more concrete, the better the plan.">
          <Textarea id="m-desc" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={'Limit to 5 attempts per minute per IP.\nReturn 429 with a Retry-After header.\nAdd a test.'} />
        </Field>
        <Field label="Which project should this change go into?">
          {modifiable.length === 0 ? <p className="text-sm text-dust">Autopilot needs a project that uses Git. Plain folders work in the Workspace.</p> : <ProjectChooser repos={modifiable} value={chosen} onChange={setSelected} />}
        </Field>
      </div>
    </Dialog>
  );
}

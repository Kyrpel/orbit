import { Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TaskImprovementDTO } from '@orbit/shared';
import { keys, post, useAction } from '../lib/api';
import { Button, Dialog, ErrorNote, Field, Input, Spinner, Textarea } from './ui';

/** The rewrite as plain text for the tracker: description, then what "done" means, then open questions. */
export function taskText(r: TaskImprovementDTO): string {
  const parts = [r.description.trim()];
  if (r.acceptanceCriteria.length) parts.push(`Acceptance criteria\n${r.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`);
  if (r.openQuestions.length) parts.push(`Open questions\n${r.openQuestions.map((c) => `- ${c}`).join('\n')}`);
  return parts.filter(Boolean).join('\n\n');
}

function ImproveDialog({ projectId, taskId, onOpenChange }: { projectId: string; taskId: string; onOpenChange: (o: boolean) => void }) {
  const improve = useAction(() => post<TaskImprovementDTO>(`/api/projects/${projectId}/tasks/${taskId}/improve`), {});
  const apply = useAction((body: { title: string; description: string }) => post(`/api/projects/${projectId}/tasks/${taskId}/apply`, body), {
    success: 'Task updated in Asana',
    invalidate: [keys.projectTasks(projectId), keys.overview],
  });
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const { mutate } = improve;

  useEffect(() => {
    mutate(undefined, {
      onSuccess: (r) => {
        setTitle(r.title);
        setText(taskText(r));
      },
    });
  }, [mutate]);

  const r = improve.data;
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      wide
      title="Improve this task"
      description="The Prompt engineer rewrites the task so an AI (or a person) can do it right the first time. Edit anything, then update it in Asana."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!r || !title.trim()} loading={apply.isPending} onClick={() => apply.mutate({ title: title.trim(), description: text }, { onSuccess: () => onOpenChange(false) })}>
            Update in Asana
          </Button>
        </>
      }
    >
      {improve.isPending ? (
        <div className="flex items-start gap-3 py-6">
          <Spinner className="mt-0.5 text-telemetry" />
          <div>
            <p className="text-sm font-[600]">The Prompt engineer is reading the task and your code…</p>
            <p className="mt-1 text-xs text-dust">This usually takes under a minute. Nothing is changed in Asana until you click Update.</p>
          </div>
        </div>
      ) : improve.error ? (
        <div className="space-y-3">
          <ErrorNote error={improve.error} />
          <Button size="sm" onClick={() => mutate(undefined)}>
            Try again
          </Button>
        </div>
      ) : r ? (
        <div className="space-y-5">
          {r.whatChanged ? <p className="rounded-[10px] bg-telemetry/[0.06] px-3 py-2 text-sm text-chalk">{r.whatChanged}</p> : null}
          <Field label="Title" htmlFor="improve-title">
            <Input id="improve-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor="improve-text">
            <Textarea id="improve-text" rows={12} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          {r.original ? (
            <details className="rounded-[10px] border border-seam px-3 py-2 text-sm">
              <summary className="cursor-pointer select-none text-dust">What the task said before</summary>
              <p className="mt-2 font-[600]">{r.original.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-dust">{r.original.description || '(no description)'}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/** "Improve" on a tracker task: opens the Prompt engineer's rewrite for review. */
export function ImproveTaskButton({ projectId, taskId, size = 'sm' }: { projectId: string; taskId: string; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant="ghost" onClick={() => setOpen(true)} title="Let the Prompt engineer rewrite this task clearly">
        <Wand2 className="size-3.5" /> Improve
      </Button>
      {open ? <ImproveDialog projectId={projectId} taskId={taskId} onOpenChange={setOpen} /> : null}
    </>
  );
}

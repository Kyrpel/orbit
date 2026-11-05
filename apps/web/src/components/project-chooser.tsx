import { RadioGroup } from 'radix-ui';
import { useState } from 'react';
import type { RepoDTO } from '@orbit/shared';
import { cn } from '../lib/utils';
import { Checkbox, Input, Switch } from './ui';

/**
 * Picks where a mission's change goes. One project is the normal case, so the
 * default is a single choice. Changes that genuinely span projects (an API and
 * the app that calls it) are an explicit opt-in.
 */
export function ProjectChooser({ repos, value, onChange }: { repos: RepoDTO[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [multi, setMulti] = useState(value.length > 1);
  const [filter, setFilter] = useState('');
  const shown = repos.filter((r) => !filter.trim() || `${r.name} ${r.localPath}`.toLowerCase().includes(filter.trim().toLowerCase()));

  if (repos.length === 0) return <p className="text-sm text-dust">Connect a project first.</p>;

  const row = (r: RepoDTO, control: React.ReactNode) => (
    <div className="flex min-w-0 items-center gap-3">
      {control}
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-chalk">{r.name}</span>
        <span className="mono block truncate text-2xs text-dust">{r.localPath}</span>
      </span>
    </div>
  );

  return (
    <div className="space-y-3">
      {repos.length > 6 ? <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter projects" aria-label="Filter projects" /> : null}
      {multi ? (
        <ul className="max-h-72 divide-y divide-seam overflow-y-auto rounded-[10px] border border-seam">
          {shown.map((r) => (
            <li key={r.id} className="px-3 py-2.5">
              <label className="block cursor-pointer">
                {row(r, <Checkbox checked={value.includes(r.id)} onCheckedChange={(v) => onChange(v ? [...value, r.id] : value.filter((x) => x !== r.id))} label={r.name} />)}
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <RadioGroup.Root value={value[0] ?? ''} onValueChange={(v) => onChange([v])} className="max-h-72 divide-y divide-seam overflow-y-auto rounded-[10px] border border-seam" aria-label="Project">
          {shown.map((r) => (
            <RadioGroup.Item key={r.id} value={r.id} className={cn('block w-full px-3 py-2.5 text-left hover:bg-hull-2/60', value[0] === r.id && 'bg-signal/6')}>
              {row(
                r,
                <span className={cn('grid size-4 shrink-0 place-items-center rounded-full border', value[0] === r.id ? 'border-signal' : 'border-seam-2')}>
                  <RadioGroup.Indicator className="size-2 rounded-full bg-signal" />
                </span>,
              )}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      )}
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          This change spans several projects
          <span className="block text-2xs text-dust">For example an API and the app that calls it. Most changes need only one.</span>
        </span>
        <Switch
          checked={multi}
          onCheckedChange={(v) => {
            setMulti(v);
            if (!v) onChange(value.slice(0, 1));
          }}
          label="This change spans several projects"
        />
      </label>
      <p className="text-2xs text-dust">
        {multi
          ? 'Orbit’s planner checks which of these actually need changes and asks you to confirm before any code is touched.'
          : 'Orbit works in a separate copy of this project (a git worktree on a new branch). Your files and main branch stay as they are.'}
      </p>
    </div>
  );
}

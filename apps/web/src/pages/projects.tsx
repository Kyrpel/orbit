import { ExternalLink, FolderPlus, ListChecks, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { newId, type CommandSpec, type ExternalProjectDTO, type RepoDTO } from '@orbit/shared';
import { ImproveTaskButton } from '../components/improve-task';
import {
  Button,
  Checkbox,
  Code,
  Dialog,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  PageHeader,
  Panel,
  PanelHeader,
  StatePill,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui';
import { api, del, keys, patch, post, useAction, useIntegrations, useProjects, useProjectTasks, useRemoteProjects, useRepos, useWorkspaces } from '../lib/api';
import { timeAgo } from '../lib/utils';

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

function CommandsEditor({ title, list, onChange }: { title: string; list: CommandSpec[]; onChange: (l: CommandSpec[]) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-[600]">{title}</p>
      {list.length === 0 ? <p className="text-xs text-dust">None.</p> : null}
      {list.map((c, i) => (
        <div key={c.id || i} className="flex items-center gap-2">
          <Switch checked={c.enabled} onCheckedChange={(v) => onChange(list.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} label={`Enable ${c.label}`} />
          <Input className="w-32" value={c.label} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Label" />
          <Input className="mono flex-1 text-xs" value={c.command} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))} aria-label="Command" />
          <Button variant="ghost" size="icon" aria-label="Remove command" onClick={() => onChange(list.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...list, { id: newId('cmd', 8), label: 'Check', command: '', timeoutSec: 600, enabled: true, source: 'user' }])}>
        <Plus className="size-3.5" /> Add command
      </Button>
    </div>
  );
}

function RepoDialog({ repo, open, onOpenChange }: { repo: RepoDTO; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [setup, setSetup] = useState(repo.setupCommands);
  const [verify, setVerify] = useState(repo.verifyCommands);
  const [branch, setBranch] = useState(repo.defaultBranch);
  const save = useAction(() => patch(`/api/repos/${repo.id}`, { setupCommands: setup.filter((c) => c.command.trim()), verifyCommands: verify.filter((c) => c.command.trim()), defaultBranch: branch }), {
    success: 'Checks saved',
    invalidate: [keys.repos],
  });
  const detect = useAction(() => post<{ setup: CommandSpec[]; verify: CommandSpec[] }>(`/api/repos/${repo.id}/detect-commands`), {});
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={`Checks for ${repo.name}`}
      description="The commands Autopilot runs to prepare and test its work. One command per line: instead of joining commands with && or |, add them separately."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => onOpenChange(false) })}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <Field label="Main branch" hint="Autopilot starts each task from this branch, and its pull requests go back into it.">
          <Input className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </Field>
        <CommandsEditor title="Before it starts (for example installing dependencies)" list={setup} onChange={setSetup} />
        <CommandsEditor title="After every change (your tests, a build, a linter)" list={verify} onChange={setVerify} />
        <Button
          size="sm"
          loading={detect.isPending}
          onClick={() =>
            detect.mutate(undefined, {
              onSuccess: (r) => {
                setSetup(r.setup);
                setVerify(r.verify);
              },
            })
          }
        >
          <RefreshCw className="size-3.5" /> Suggest from the project files
        </Button>
      </div>
    </Dialog>
  );
}

function RepoRow({ repo }: { repo: RepoDTO }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const toggle = useAction((allowModify: boolean) => patch(`/api/repos/${repo.id}`, { allowModify }), { invalidate: [keys.repos] });
  const remove = useAction(() => del(`/api/repos/${repo.id}`), { success: `Removed ${repo.name} from Orbit. The folder was not touched.`, invalidate: [keys.repos] });
  const checks = repo.verifyCommands.filter((c) => c.enabled).length;
  const facts = [repo.summary?.languages.slice(0, 3).join(', '), repo.isGit ? `branch ${repo.defaultBranch}` : 'plain folder', repo.isGit && checks ? `${checks} ${checks === 1 ? 'check' : 'checks'}` : null].filter(Boolean);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-[600]">{repo.name}</span>
          {repo.github ? (
            <a href={`https://github.com/${repo.github.owner}/${repo.github.repo}`} target="_blank" rel="noreferrer" className="text-dust hover:text-chalk" aria-label="Open on GitHub">
              <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>
        <p className="mono truncate text-2xs text-dust" title={repo.localPath}>
          {repo.localPath}
        </p>
        <p className="mt-0.5 text-2xs text-dust">{facts.join(' · ')}</p>
      </div>
      {confirm ? (
        <span className="flex flex-wrap items-center gap-2 text-xs">
          Remove from Orbit? The folder stays on your computer.
          <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate(undefined)}>
            Remove
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <>
          <label className="flex items-center gap-2 text-xs text-dust" title="Off: the AI can read this project and answer questions, but never changes a file.">
            AI may edit files
            <Switch checked={repo.allowModify} onCheckedChange={(v) => toggle.mutate(v)} label={`Let the AI edit files in ${repo.name}`} />
          </label>
          {repo.isGit ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} title="The commands Autopilot runs to test its work">
              <ListChecks className="size-3.5" /> Checks
            </Button>
          ) : null}
          <Button size="icon" variant="ghost" aria-label={`Remove ${repo.name} from Orbit`} title="Remove from Orbit" onClick={() => setConfirm(true)}>
            <Trash2 className="size-4" />
          </Button>
        </>
      )}
      {editing ? <RepoDialog repo={repo} open={editing} onOpenChange={setEditing} /> : null}
    </li>
  );
}

export function AddRepoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [path, setPath] = useState('');
  const [root, setRoot] = useState('');
  const [found, setFound] = useState<{ path: string; name: string; connectedRepoId: string | null }[] | null>(null);
  const [gh, setGh] = useState<{ nameWithOwner: string; description: string | null; visibility: string; connectedRepoId: string | null }[] | null>(null);
  const add = useAction((p: string) => post<RepoDTO>('/api/repos', { path: p }), { success: (r) => `Added ${r.name}`, invalidate: [keys.repos, keys.overview] });
  const scan = useAction((r: string) => post<typeof found>('/api/repos/scan', { root: r }), {});
  const listGh = useAction(() => api<NonNullable<typeof gh>>('/api/repos/github'), {});
  const clone = useAction((n: string) => post<RepoDTO>('/api/repos/clone', { nameWithOwner: n }), { success: (r) => `Downloaded and added ${r.name}`, invalidate: [keys.repos, keys.overview] });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} wide title="Add a project" description="Any folder on this computer. Orbit only works in the folders you add, and only when you ask.">
      <Tabs defaultValue="local">
        <TabsList className="-mx-6 mb-5 px-5">
          <TabsTrigger value="local">A folder</TabsTrigger>
          <TabsTrigger value="scan">Find my projects</TabsTrigger>
          <TabsTrigger value="github">From GitHub</TabsTrigger>
        </TabsList>
        <TabsContent value="local" className="space-y-3">
          <Field label="Folder path" hint="Tip: open the folder in File Explorer, click the address bar and copy what it shows.">
            <Input className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder={'C:\\Users\\you\\Documents\\my-project'} />
          </Field>
          <Button variant="primary" loading={add.isPending} disabled={!path.trim()} onClick={() => add.mutate(path, { onSuccess: () => setPath('') })}>
            Add project
          </Button>
        </TabsContent>
        <TabsContent value="scan" className="space-y-3">
          <Field label="Where do you keep your projects?" hint="Orbit lists the Git projects in this folder and the folders directly inside it, never deeper.">
            <div className="flex gap-2">
              <Input className="mono" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="C:\\code" />
              <Button loading={scan.isPending} disabled={!root.trim()} onClick={() => scan.mutate(root, { onSuccess: (r) => setFound(r) })}>
                Look
              </Button>
            </div>
          </Field>
          {found ? (
            found.length === 0 ? (
              <p className="text-sm text-dust">No Git projects found there. A plain folder can be added by its path.</p>
            ) : (
              <ul className="divide-y divide-seam rounded-[10px] border border-seam">
                {found.map((f) => (
                  <li key={f.path} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{f.name}</p>
                      <p className="mono truncate text-2xs text-dust">{f.path}</p>
                    </div>
                    {f.connectedRepoId ? (
                      <span className="text-xs text-go">Added</span>
                    ) : (
                      <Button size="sm" onClick={() => add.mutate(f.path, { onSuccess: () => setFound(found.map((x) => (x.path === f.path ? { ...x, connectedRepoId: 'yes' } : x))) })}>
                        Add
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </TabsContent>
        <TabsContent value="github" className="space-y-3">
          <p className="text-sm text-dust">
            Orbit downloads a copy with your GitHub login and keeps it in its own data folder.
          </p>
          {!gh ? (
            <Button loading={listGh.isPending} onClick={() => listGh.mutate(undefined, { onSuccess: (r) => setGh(r) })}>
              Show my GitHub projects
            </Button>
          ) : (
            <ul className="max-h-80 divide-y divide-seam overflow-y-auto rounded-[10px] border border-seam">
              {gh.map((r) => (
                <li key={r.nameWithOwner} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      {r.nameWithOwner} <span className="text-2xs text-dust">{r.visibility.toLowerCase()}</span>
                    </p>
                    {r.description ? <p className="truncate text-2xs text-dust">{r.description}</p> : null}
                  </div>
                  {r.connectedRepoId ? (
                    <span className="text-xs text-go">Added</span>
                  ) : (
                    <Button size="sm" loading={clone.isPending && clone.variables === r.nameWithOwner} onClick={() => clone.mutate(r.nameWithOwner, { onSuccess: () => setGh(gh.map((x) => (x.nameWithOwner === r.nameWithOwner ? { ...x, connectedRepoId: 'yes' } : x))) })}>
                      Download
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Asana projects
// ---------------------------------------------------------------------------

function MappingDialog({ project, repos, open, onOpenChange }: { project: ExternalProjectDTO; repos: RepoDTO[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [chosen, setChosen] = useState(project.repoIds);
  const save = useAction(() => patch(`/api/projects/${project.id}`, { repoIds: chosen }), { success: 'Saved', invalidate: [keys.projects, keys.repos] });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Projects for ${project.name}`}
      description="Tasks from this Asana project may only change the projects you tick. With several, the planner suggests which ones a task needs and you confirm."
      footer={
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => onOpenChange(false) })}>
          Save
        </Button>
      }
    >
      <RepoPicker repos={repos} chosen={chosen} onChange={setChosen} />
    </Dialog>
  );
}

export function RepoPicker({ repos, chosen, onChange }: { repos: RepoDTO[]; chosen: string[]; onChange: (ids: string[]) => void }) {
  if (repos.length === 0) return <p className="text-sm text-dust">Add a project first.</p>;
  return (
    <ul className="divide-y divide-seam rounded-[10px] border border-seam">
      {repos.map((r) => (
        <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
          <Checkbox id={`map-${r.id}`} checked={chosen.includes(r.id)} onCheckedChange={(v) => onChange(v ? [...chosen, r.id] : chosen.filter((x) => x !== r.id))} />
          <label htmlFor={`map-${r.id}`} className="min-w-0 flex-1 cursor-pointer">
            <span className="block text-sm">{r.name}</span>
            <span className="mono block truncate text-2xs text-dust">{r.localPath}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function TaskList({ project }: { project: ExternalProjectDTO }) {
  const tasks = useProjectTasks(project.id);
  const [selected, setSelected] = useState<string[]>([]);
  const run = useAction((ids: string[]) => post<{ taskId: string; missionId: string | null; created: boolean; error: string | null }[]>(`/api/projects/${project.id}/run`, { taskIds: ids }), {
    success: (r) => {
      const ok = r.filter((x) => x.missionId).length;
      const failed = r.filter((x) => x.error).length;
      return `${ok} ${ok === 1 ? 'task' : 'tasks'} started${failed ? `, ${failed} failed` : ''}`;
    },
    invalidate: [keys.projectTasks(project.id), ['missions'], keys.overview],
  });
  if (tasks.isPending) return <Loading label="Loading tasks from Asana" />;
  if (tasks.error) return <div className="p-4"><ErrorNote error={tasks.error} /></div>;
  const ready = tasks.data.filter((t) => !t.completed);
  if (!ready.length) return <p className="px-5 py-4 text-sm text-dust">No open tasks in this project.</p>;
  return (
    <div className="border-t border-seam bg-night/40">
      <div className="flex items-center justify-between gap-3 px-5 py-2.5">
        <p className="text-xs text-dust">Pick the tasks to run. Orbit never runs a whole project on its own.</p>
        <Button size="sm" variant="primary" disabled={!selected.length || !project.repoIds.length} loading={run.isPending} onClick={() => run.mutate(selected, { onSuccess: () => setSelected([]) })}>
          Run selected ({selected.length})
        </Button>
      </div>
      <ul className="max-h-96 divide-y divide-seam overflow-y-auto">
        {ready.map((t) => {
          return (
            <li key={t.id} className="flex items-center gap-3 px-5 py-2.5">
              <Checkbox id={`task-${t.id}`} checked={selected.includes(t.id)} onCheckedChange={(v) => setSelected(v ? [...selected, t.id] : selected.filter((x) => x !== t.id))} label={t.title} />
              <label htmlFor={`task-${t.id}`} className="min-w-0 flex-1 cursor-pointer">
                <span className="block truncate text-sm">{t.title}</span>
                <span className="block text-2xs text-dust">{t.assignee ?? 'unassigned'}{t.updatedAt ? `, updated ${timeAgo(t.updatedAt)}` : ''}</span>
              </label>
              <ImproveTaskButton projectId={project.id} taskId={t.id} />
              {t.mission ? (
                <Link to={`/missions/${t.mission.id}`}>
                  <StatePill status={t.mission.status} />
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProjectRow({ project, repos }: { project: ExternalProjectDTO; repos: RepoDTO[] }) {
  const [mapping, setMapping] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const toggle = useAction((v: boolean) => patch(`/api/projects/${project.id}`, { triggersEnabled: v }), { invalidate: [keys.projects] });
  const poll = useAction(() => post<{ triggers: number; error: string | null }>(`/api/projects/${project.id}/poll`), {
    success: (r) => (r.error ? `Check failed: ${r.error}` : r.triggers ? `Found ${r.triggers} new /orbit command(s)` : 'No new /orbit commands'),
    invalidate: [keys.projects, ['missions']],
  });
  const remove = useAction(() => del(`/api/projects/${project.id}`), { success: 'Asana project disconnected', invalidate: [keys.projects] });
  const mapped = repos.filter((r) => project.repoIds.includes(r.id));
  return (
    <li>
      <div className="flex flex-wrap items-center gap-4 px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-[600]">{project.name}</span>
            {project.url ? (
              <a href={project.url} target="_blank" rel="noreferrer" className="text-dust hover:text-chalk" aria-label="Open in Asana">
                <ExternalLink className="size-3.5" />
              </a>
            ) : null}
          </div>
          <p className="text-2xs text-dust">
            {mapped.length ? `Works in ${mapped.map((r) => r.name).join(', ')}` : <span className="text-signal-deep">Choose its projects first</span>}
            {project.lastPolledAt ? `. Checked ${timeAgo(project.lastPolledAt)}` : '. Not checked yet'}
          </p>
          {project.pollError ? <p className="text-2xs text-fault">{project.pollError}</p> : null}
        </div>
        <label className="flex items-center gap-2 text-xs text-dust">
          /orbit run comments
          <Switch checked={project.triggersEnabled} onCheckedChange={(v) => toggle.mutate(v)} label="Listen for /orbit run comments" />
        </label>
        <Button size="sm" onClick={() => setMapping(true)}>
          Projects
        </Button>
        <Button size="sm" onClick={() => setShowTasks((s) => !s)} aria-expanded={showTasks}>
          {showTasks ? 'Hide tasks' : 'Run ready tasks'}
        </Button>
        <Button size="icon" variant="ghost" aria-label="Check for /orbit commands now" loading={poll.isPending} onClick={() => poll.mutate(undefined)}>
          <RefreshCw className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label={`Disconnect ${project.name}`} loading={remove.isPending} onClick={() => remove.mutate(undefined)}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      {showTasks ? <TaskList project={project} /> : null}
      {mapping ? <MappingDialog project={project} repos={repos} open={mapping} onOpenChange={setMapping} /> : null}
    </li>
  );
}

export function ConnectProjectDialog({ integrationId, repos, open, onOpenChange }: { integrationId: string; repos: RepoDTO[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const workspaces = useWorkspaces(open ? integrationId : null);
  const [ws, setWs] = useState<string | null>(null);
  const workspace = ws ?? workspaces.data?.[0]?.id ?? null;
  const projects = useRemoteProjects(open ? integrationId : null, workspace);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>(repos.length === 1 ? [repos[0]!.id] : []);
  const connect = useAction(() => post<ExternalProjectDTO>('/api/projects', { integrationId, externalProjectId: projectId, repoIds: chosen }), {
    success: (p) => `Connected ${p.name}`,
    invalidate: [keys.projects, keys.repos, keys.overview],
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Connect an Asana project"
      description="Orbit reads tasks from it, listens for /orbit run comments, and posts progress back to the task."
      footer={
        <Button variant="primary" disabled={!projectId} loading={connect.isPending} onClick={() => connect.mutate(undefined, { onSuccess: () => onOpenChange(false) })}>
          Connect project
        </Button>
      }
    >
      <div className="space-y-5">
        {workspaces.error ? <ErrorNote error={workspaces.error} /> : null}
        {(workspaces.data?.length ?? 0) > 1 ? (
          <Field label="Workspace">
            <select className="h-9 w-full rounded-[8px] border border-seam bg-night px-3 text-sm" value={workspace ?? ''} onChange={(e) => setWs(e.target.value)}>
              {workspaces.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Project">
          {projects.isPending && workspace ? (
            <Loading label="Loading projects" />
          ) : (
            <ul className="max-h-56 divide-y divide-seam overflow-y-auto rounded-[10px] border border-seam">
              {(projects.data ?? []).map((p) => (
                <li key={p.id}>
                  <button
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-hull-2 ${projectId === p.id ? 'bg-hull-2 text-chalk' : ''}`}
                    onClick={() => setProjectId(p.id)}
                    disabled={!!p.connectedProjectId}
                  >
                    {p.name}
                    {p.connectedProjectId ? <span className="text-2xs text-go">connected</span> : projectId === p.id ? <span className="text-2xs text-signal-deep">selected</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="Projects its tasks may change">
          <RepoPicker repos={repos} chosen={chosen} onChange={setChosen} />
        </Field>
      </div>
    </Dialog>
  );
}

export function ProjectsPage() {
  const repos = useRepos();
  const projects = useProjects();
  const integrations = useIntegrations();
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const asana = integrations.data?.find((i) => i.provider === 'asana' && i.status === 'connected');
  return (
    <>
      <PageHeader
        title="Projects"
        description="The folders Orbit can work in. It never looks anywhere else."
        action={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <FolderPlus className="size-4" /> Add a project
          </Button>
        }
      />
      <div className="space-y-6">
        <Panel>
          {repos.isPending ? (
            <Loading label="Loading your projects" />
          ) : repos.error ? (
            <div className="p-5">
              <ErrorNote error={repos.error} />
            </div>
          ) : repos.data?.length ? (
            <ul className="divide-y divide-seam">
              {repos.data.map((r) => (
                <RepoRow key={r.id} repo={r} />
              ))}
            </ul>
          ) : (
            <Empty title="No projects yet.">A project is any folder on this computer: code, documents, a website. Add one to start working on it with an AI.</Empty>
          )}
        </Panel>

        {asana ? (
          <Panel>
            <PanelHeader
              title="Asana projects"
              description="Choose which of your projects each Asana project's tasks may change."
              action={
                <Button size="sm" onClick={() => setConnecting(true)}>
                  <Plus className="size-3.5" /> Connect an Asana project
                </Button>
              }
            />
            {projects.isPending ? (
              <Loading />
            ) : projects.data?.length ? (
              <ul className="divide-y divide-seam">
                {projects.data.map((p) => (
                  <ProjectRow key={p.id} project={p} repos={repos.data ?? []} />
                ))}
              </ul>
            ) : (
              <Empty title="No Asana projects connected.">Connect one to run its tasks on Autopilot, from here or by commenting /orbit run on a task.</Empty>
            )}
          </Panel>
        ) : (
          <p className="px-1 text-sm text-dust">
            Keep your tasks in Asana?{' '}
            <Link to="/integrations" className="text-chalk underline decoration-seam-2 underline-offset-4 hover:decoration-chalk">
              Connect it
            </Link>{' '}
            and Autopilot can pick them up.
          </p>
        )}
      </div>
      <AddRepoDialog open={adding} onOpenChange={setAdding} />
      {asana && connecting ? <ConnectProjectDialog integrationId={asana.id} repos={repos.data ?? []} open={connecting} onOpenChange={setConnecting} /> : null}
    </>
  );
}

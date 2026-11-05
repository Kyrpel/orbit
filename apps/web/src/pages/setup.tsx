import { Check, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { MissionSummaryDTO, RepoDTO, Settings } from '@orbit/shared';
import { Button, Code, Field, Input, Loading, Panel, Textarea, Toaster } from '../components/ui';
import { keys, patch, post, useAction, useDoctor, useIntegrations, useProjects, useRepos, useSettings } from '../lib/api';
import { cn } from '../lib/utils';
import { AsanaConnectForm } from './integrations';
import { ProjectChooser } from '../components/project-chooser';
import { ConnectProjectDialog } from './projects';
import { Choice, ConsentControl, RuntimeChoice, useSaveSettings, WindowsSandboxNote } from './settings';

const STEPS = ['Check your tools', 'GitHub', 'Repositories', 'Asana', 'Map projects', 'Your AI team', 'First mission'] as const;

function StepShell({ title, description, children, footer }: { title: string; description: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <Panel>
      <div className="border-b border-seam px-6 py-5">
        <h2 className="text-xl">{title}</h2>
        <p className="mt-1 max-w-[64ch] text-sm text-dust">{description}</p>
      </div>
      <div className="px-6 py-5">{children}</div>
      <div className="flex justify-between gap-2 border-t border-seam px-6 py-4">{footer}</div>
    </Panel>
  );
}

function Tools({ next }: { next: () => void }) {
  const doctor = useDoctor();
  const ids = ['node', 'git', 'git-identity', 'gh', 'home'];
  return (
    <StepShell title="Check your tools" description="Orbit drives the git and GitHub CLI already on your machine. Nothing is installed for you." footer={<><span /><Button variant="primary" onClick={next}>Continue</Button></>}>
      {doctor.isPending ? (
        <Loading label="Checking" />
      ) : (
        <ul className="space-y-3">
          {doctor.data?.checks
            .filter((c) => ids.includes(c.id))
            .map((c) => (
              <li key={c.id} className="flex gap-3 text-sm">
                {c.status === 'ok' ? <Check className="mt-0.5 size-4 shrink-0 text-go" /> : <X className={cn('mt-0.5 size-4 shrink-0', c.status === 'error' ? 'text-fault' : 'text-signal-deep')} />}
                <div>
                  <p>
                    <span className="font-[600]">{c.label}</span> <span className="text-dust">{c.detail}</span>
                  </p>
                  {c.fix && c.status !== 'ok' ? <p className="mono mt-0.5 text-2xs text-dust">{c.fix}</p> : null}
                </div>
              </li>
            ))}
        </ul>
      )}
    </StepShell>
  );
}

function GitHubStep({ next, back }: { next: () => void; back: () => void }) {
  const doctor = useDoctor();
  const gh = doctor.data?.checks.find((c) => c.id === 'gh');
  return (
    <StepShell
      title="Connect GitHub"
      description="Orbit opens pull requests with your own GitHub CLI login, and only after you approve each one. It never stores GitHub tokens."
      footer={<><Button variant="ghost" onClick={back}>Back</Button><Button variant="primary" onClick={next}>{gh?.status === 'ok' ? 'Continue' : 'Continue without GitHub'}</Button></>}
    >
      {!gh ? (
        <Loading />
      ) : gh.status === 'ok' ? (
        <p className="flex items-center gap-2 text-sm">
          <Check className="size-4 text-go" /> {gh.detail}
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          <p>{gh.detail}</p>
          <p className="text-dust">
            Run <Code>gh auth login</Code> in a terminal, then click <span className="text-chalk">Check again</span>. Without it, missions finish as local commits.
          </p>
          <Button size="sm" onClick={() => void doctor.refetch()}>
            Check again
          </Button>
        </div>
      )}
    </StepShell>
  );
}

function ReposStep({ next, back }: { next: () => void; back: () => void }) {
  const repos = useRepos();
  const [path, setPath] = useState('');
  const [root, setRoot] = useState('');
  const [found, setFound] = useState<{ path: string; name: string; connectedRepoId: string | null }[] | null>(null);
  const add = useAction((p: string) => post<RepoDTO>('/api/repos', { path: p }), { success: (r) => `Connected ${r.name}`, invalidate: [keys.repos, keys.overview] });
  const scan = useAction((r: string) => post<typeof found>('/api/repos/scan', { root: r }), {});
  return (
    <StepShell
      title="Choose repositories"
      description="Connect the repositories Orbit may work on. It reads them, and changes code only inside separate worktrees on new branches."
      footer={<><Button variant="ghost" onClick={back}>Back</Button><Button variant="primary" disabled={!repos.data?.length} onClick={next}>Continue</Button></>}
    >
      <div className="space-y-5">
        <Field label="Repository path" htmlFor="setup-path">
          <div className="flex gap-2">
            <Input id="setup-path" className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\\code\\my-app" />
            <Button loading={add.isPending} disabled={!path.trim()} onClick={() => add.mutate(path, { onSuccess: () => setPath('') })}>
              Connect
            </Button>
          </div>
        </Field>
        <Field label="Or scan a folder" htmlFor="setup-root" hint="Checks that folder and its direct subfolders only.">
          <div className="flex gap-2">
            <Input id="setup-root" className="mono" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="C:\\code" />
            <Button loading={scan.isPending} disabled={!root.trim()} onClick={() => scan.mutate(root, { onSuccess: setFound })}>
              Scan
            </Button>
          </div>
        </Field>
        {found?.length ? (
          <ul className="divide-y divide-seam rounded-[10px] border border-seam">
            {found.map((f) => (
              <li key={f.path} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="flex-1">{f.name}</span>
                {f.connectedRepoId ? <span className="text-xs text-go">Connected</span> : <Button size="sm" onClick={() => add.mutate(f.path, { onSuccess: () => setFound(found.map((x) => (x.path === f.path ? { ...x, connectedRepoId: 'yes' } : x))) })}>Connect</Button>}
              </li>
            ))}
          </ul>
        ) : found ? (
          <p className="text-sm text-dust">No repositories found there.</p>
        ) : null}
        {repos.data?.length ? (
          <div>
            <p className="text-xs font-[600]">Connected</p>
            <ul className="mt-2 space-y-1 text-sm">
              {repos.data.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <Check className="size-4 text-go" /> {r.name}
                  <span className="text-2xs text-dust">{r.verifyCommands.length ? `${r.verifyCommands.length} checks detected` : 'no checks detected'}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </StepShell>
  );
}

function AsanaStep({ next, back }: { next: (skipMapping: boolean) => void; back: () => void }) {
  const integrations = useIntegrations();
  const connected = integrations.data?.find((i) => i.provider === 'asana');
  return (
    <StepShell
      title="Connect Asana (optional)"
      description="Run tasks straight from Asana and get progress and pull request links posted back. You can skip this and use Orbit with tasks you type in."
      footer={<><Button variant="ghost" onClick={back}>Back</Button><Button variant={connected ? 'primary' : 'secondary'} onClick={() => next(!connected)}>{connected ? 'Continue' : 'Skip for now'}</Button></>}
    >
      {connected ? (
        <p className="flex items-center gap-2 text-sm">
          <Check className="size-4 text-go" /> Connected as {connected.account.name ?? connected.account.id}
        </p>
      ) : (
        <AsanaConnectForm />
      )}
    </StepShell>
  );
}

function MapStep({ next, back }: { next: () => void; back: () => void }) {
  const integrations = useIntegrations();
  const projects = useProjects();
  const repos = useRepos();
  const [open, setOpen] = useState(false);
  const asana = integrations.data?.find((i) => i.provider === 'asana');
  return (
    <StepShell
      title="Map projects to repositories"
      description="Tasks from a project may only change the repositories you map here. With several, the planner proposes which ones a task needs and you confirm."
      footer={<><Button variant="ghost" onClick={back}>Back</Button><Button variant="primary" onClick={next}>Continue</Button></>}
    >
      <div className="space-y-4">
        {projects.data?.length ? (
          <ul className="space-y-1 text-sm">
            {projects.data.map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <Check className="size-4 text-go" /> {p.name}
                <span className="text-2xs text-dust">{p.repoIds.map((id) => repos.data?.find((r) => r.id === id)?.name).filter(Boolean).join(', ') || 'no repositories'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-dust">No projects connected yet.</p>
        )}
        {asana ? <Button onClick={() => setOpen(true)}>Connect a project</Button> : null}
        {asana && open ? <ConnectProjectDialog integrationId={asana.id} repos={repos.data ?? []} open={open} onOpenChange={setOpen} /> : null}
      </div>
    </StepShell>
  );
}

function TeamStep({ next, back }: { next: () => void; back: () => void }) {
  const settings = useSettings();
  const save = useSaveSettings();
  const doctor = useDoctor();
  if (!settings.data) return <Loading />;
  const s: Settings = settings.data;
  const ready =
    s.execution.runtime === 'auto'
      ? !!doctor.data?.runtimes.some((r) => r.kind === 'ai' && r.available)
      : !!doctor.data?.runtimes.find((r) => r.id === s.execution.runtime)?.available;
  return (
    <StepShell
      title="Set up your AI team"
      description="A planner, an engineer and a reviewer, started on demand for each mission."
      footer={<><Button variant="ghost" onClick={back}>Back</Button><Button variant="primary" disabled={!ready} onClick={next}>Continue</Button></>}
    >
      <div className="space-y-5">
        <RuntimeChoice s={s} onChange={(r) => save.mutate({ execution: { runtime: r } })} />
        <WindowsSandboxNote platform={doctor.data?.platform} mode={s.execution.mode} />
        <Choice
          value={s.execution.mode}
          onChange={(mode) => save.mutate({ execution: { mode } })}
          options={[
            { value: 'sandbox', label: 'Sandboxed agents', description: "Engineer commands must run inside Claude Code's OS sandbox, or the mission stops." },
            { value: 'trusted-local', label: 'Trusted-local agents', description: 'Engineer commands run directly on this machine with your permissions. Needs consent.' },
          ]}
        />
        <ConsentControl s={s} />
      </div>
    </StepShell>
  );
}

function FirstMission({ back, finish }: { back: () => void; finish: (id: string) => void }) {
  const repos = useRepos();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const modifiable = (repos.data ?? []).filter((r) => r.allowModify);
  const ids = chosen.length ? chosen : modifiable.length === 1 ? [modifiable[0]!.id] : [];
  const create = useAction(() => post<{ mission: MissionSummaryDTO }>('/api/missions', { title, description: body, repoIds: ids }), { invalidate: [['missions'], keys.overview] });
  return (
    <StepShell
      title="Run your first mission"
      description="Pick something small and concrete. You will approve the result before anything is committed, and again before anything is pushed."
      footer={
        <>
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
          <Button variant="primary" disabled={!title.trim() || !ids.length} loading={create.isPending} onClick={() => create.mutate(undefined, { onSuccess: (r) => finish(r.mission.id) })}>
            Run with Orbit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="What should change?" htmlFor="first-title">
          <Input id="first-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a /health endpoint that returns the app version" />
        </Field>
        <Field label="Details" htmlFor="first-body">
          <Textarea id="first-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Return JSON { status, version }. Add a test." />
        </Field>
        {modifiable.length > 1 ? (
          <Field label="Which project should this change go into?">
            <ProjectChooser repos={modifiable} value={ids} onChange={setChosen} />
          </Field>
        ) : null}
      </div>
    </StepShell>
  );
}

export function SetupPage() {
  const [step, setStep] = useState(0);
  const [skipMapping, setSkipMapping] = useState(false);
  const navigate = useNavigate();
  const complete = useAction(() => patch('/api/settings', { onboarding: { completedAt: new Date().toISOString() } }), { invalidate: [keys.settings, keys.overview] });
  const done = (to = '/') => complete.mutate(undefined, { onSuccess: () => navigate(to) });
  const go = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));

  return (
    <div className="min-h-screen px-5 py-10 md:py-16">
      <div className="mx-auto grid max-w-[1040px] gap-10 md:grid-cols-[220px_minmax(0,1fr)]">
        <div>
          <div className="mb-8 flex items-center gap-2.5">
            <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
              <ellipse cx="16" cy="16" rx="12.5" ry="7" fill="none" stroke="var(--color-telemetry)" strokeWidth="1.5" transform="rotate(-24 16 16)" />
              <circle cx="16" cy="16" r="4.4" fill="var(--color-chalk)" />
              <circle cx="26.6" cy="11.2" r="2.4" fill="var(--color-signal)" />
            </svg>
            <span className="text-lg font-[680] tracking-[-0.02em]">Orbit</span>
          </div>
          <ol className="space-y-1" aria-label="Setup steps">
            {STEPS.map((label, i) => (
              <li key={label}>
                <button
                  onClick={() => i < step && go(i)}
                  className={cn('flex w-full items-center gap-3 rounded-[8px] px-2 py-1.5 text-left text-sm', i === step ? 'bg-hull text-chalk' : i < step ? 'text-chalk/80 hover:bg-hull/60' : 'text-dust-2')}
                  aria-current={i === step ? 'step' : undefined}
                  disabled={i > step}
                >
                  <span className={cn('grid size-5 shrink-0 place-items-center rounded-full text-2xs tabular', i < step ? 'bg-go/15 text-go' : i === step ? 'bg-signal text-signal-ink' : 'border border-seam-2')}>
                    {i < step ? <Check className="size-3" /> : i + 1}
                  </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
          <button className="mt-8 text-xs text-dust hover:text-chalk" onClick={() => done('/')}>
            Skip setup
          </button>
        </div>
        <div>
          {step === 0 ? <Tools next={() => go(1)} /> : null}
          {step === 1 ? <GitHubStep next={() => go(2)} back={() => go(0)} /> : null}
          {step === 2 ? <ReposStep next={() => go(3)} back={() => go(1)} /> : null}
          {step === 3 ? (
            <AsanaStep
              back={() => go(2)}
              next={(skip) => {
                setSkipMapping(skip);
                go(skip ? 5 : 4);
              }}
            />
          ) : null}
          {step === 4 ? <MapStep next={() => go(5)} back={() => go(3)} /> : null}
          {step === 5 ? <TeamStep next={() => go(6)} back={() => go(skipMapping ? 3 : 4)} /> : null}
          {step === 6 ? <FirstMission back={() => go(5)} finish={(id) => done(`/missions/${id}`)} /> : null}
        </div>
      </div>
      <Toaster />
    </div>
  );
}

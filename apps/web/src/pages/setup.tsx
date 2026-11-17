import { Check, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { RepoDTO, Settings } from '@orbit/shared';
import { Button, Code, Disclosure, Field, Input, Loading, Panel, Toaster } from '../components/ui';
import { keys, patch, post, useAction, useDoctor, useIntegrations, useProjects, useRepos, useSettings } from '../lib/api';
import { cn, shortPath } from '../lib/utils';
import { AsanaConnectForm } from './integrations';
import { ConnectProjectDialog } from './projects';
import { RuntimeChoice, useSaveSettings } from './settings';

/*
  First run: three short steps and you are in the workspace. Add a folder, see which AI
  Orbit found, and (only if you want) connect GitHub and Asana. Everything here can be
  changed later, and what Autopilot needs is asked the first time you use Autopilot.
*/

const STEPS = ['Add a project', 'Your AI', 'Extras'] as const;

function StepShell({ title, description, children, footer }: { title: string; description: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <Panel>
      <div className="border-b border-seam px-6 py-5">
        <h1 className="text-xl">{title}</h1>
        <p className="mt-1 max-w-[64ch] text-sm text-dust">{description}</p>
      </div>
      <div className="px-6 py-5">{children}</div>
      <div className="flex justify-between gap-2 border-t border-seam px-6 py-4">{footer}</div>
    </Panel>
  );
}

function Mark({ ok }: { ok: boolean }) {
  return ok ? <Check className="mt-0.5 size-4 shrink-0 text-go" aria-label="Ready" /> : <X className="mt-0.5 size-4 shrink-0 text-dust" aria-label="Not ready" />;
}

function ProjectStep({ next }: { next: () => void }) {
  const repos = useRepos();
  const [path, setPath] = useState('');
  const [root, setRoot] = useState('');
  const [found, setFound] = useState<{ path: string; name: string; connectedRepoId: string | null }[] | null>(null);
  const add = useAction((p: string) => post<RepoDTO>('/api/repos', { path: p }), { success: (r) => `Added ${r.name}`, invalidate: [keys.repos, keys.overview] });
  const scan = useAction((r: string) => post<typeof found>('/api/repos/scan', { root: r }), {});
  const count = repos.data?.length ?? 0;
  return (
    <StepShell
      title="Add your first project"
      description="A project is any folder on this computer: code, documents, a website. Orbit only works in the folders you add, and only when you ask."
      footer={
        <>
          <span />
          <Button variant="primary" disabled={!count} onClick={next}>
            Continue
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) add.mutate(path.trim(), { onSuccess: () => setPath('') });
          }}
        >
          <Field label="Folder path" htmlFor="setup-path" hint="Tip: open the folder in File Explorer, click the address bar and copy what it shows.">
            <div className="flex gap-2">
              <Input id="setup-path" className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\you\Documents\my-project" autoFocus />
              <Button type="submit" variant={count ? 'secondary' : 'primary'} loading={add.isPending} disabled={!path.trim()}>
                Add
              </Button>
            </div>
          </Field>
        </form>

        {count ? (
          <ul className="divide-y divide-seam rounded-[10px] border border-seam">
            {repos.data?.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Check className="size-4 shrink-0 text-go" aria-hidden />
                <span className="font-[600]">{r.name}</span>
                <span className="mono min-w-0 flex-1 truncate text-2xs text-dust" title={r.localPath}>
                  {shortPath(r.localPath, 3)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <Disclosure title="Have several? Let Orbit find them" summary="Lists the Git projects in one folder, so you can add them with a click." className="-mx-5">
          <div className="space-y-3 px-5 pb-1">
            <Field label="Where do you keep your projects?" htmlFor="setup-root" hint="Orbit looks in this folder and the folders directly inside it, never deeper.">
              <div className="flex gap-2">
                <Input id="setup-root" className="mono" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="C:\code" />
                <Button loading={scan.isPending} disabled={!root.trim()} onClick={() => scan.mutate(root, { onSuccess: setFound })}>
                  Look
                </Button>
              </div>
            </Field>
            {found?.length ? (
              <ul className="divide-y divide-seam rounded-[10px] border border-seam">
                {found.map((f) => (
                  <li key={f.path} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
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
            ) : found ? (
              <p className="text-sm text-dust">No Git projects found there. A plain folder can be added by its path above.</p>
            ) : null}
          </div>
        </Disclosure>
      </div>
    </StepShell>
  );
}

function AiStep({ next, back }: { next: () => void; back: () => void }) {
  const settings = useSettings();
  const save = useSaveSettings();
  const doctor = useDoctor();
  if (!settings.data) return <Loading />;
  const s: Settings = settings.data;
  const demo = s.execution.runtime === 'scripted';
  const ais = doctor.data?.runtimes.filter((r) => r.kind === 'ai' || r.id === s.execution.runtime) ?? [];
  const ready = s.execution.runtime === 'auto' ? ais.some((r) => r.available && r.kind === 'ai') : !!doctor.data?.runtimes.find((r) => r.id === s.execution.runtime)?.available;
  return (
    <StepShell
      title={demo ? 'Demo mode is on' : ready ? 'Your AI is ready' : 'Connect an AI'}
      description="Orbit works through the AI tools already on this computer, with your own logins. It never sees or stores their passwords."
      footer={
        <>
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
          <Button variant={ready ? 'primary' : 'secondary'} onClick={next}>
            {ready ? 'Continue' : 'Continue without an AI'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {doctor.isPending ? (
          <Loading label="Looking for AI tools on this computer" />
        ) : (
          <ul className="space-y-3">
            {ais.map((r) => (
              <li key={r.id} className="flex gap-3 text-sm">
                <Mark ok={r.available} />
                <div className="min-w-0">
                  <p className="font-[600]">{r.displayName}</p>
                  <p className="text-xs text-dust">{r.kind !== 'ai' ? 'No AI. It only makes example changes, so you can look around.' : r.available ? 'Ready to use.' : (r.reason ?? 'Not found on this computer.')}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!ready && !doctor.isPending ? (
          <div className="rounded-[10px] border border-signal/45 bg-signal/6 px-4 py-3 text-sm">
            <p className="font-[600]">No AI is ready yet</p>
            <p className="mt-1 text-xs text-dust">
              The quickest way: install Claude Code, run <Code>claude</Code> once in a terminal to sign in, then check again. You can also look around first and connect one later in Settings.
            </p>
            <Button size="sm" className="mt-3" loading={doctor.isFetching} onClick={() => void doctor.refetch()}>
              Check again
            </Button>
          </div>
        ) : null}
        <Disclosure title="Choose how Orbit reaches Claude" summary="Automatic is right for almost everyone." className="-mx-5">
          <div className="px-5 pb-1">
            <RuntimeChoice s={s} onChange={(r) => save.mutate({ execution: { runtime: r } })} />
          </div>
        </Disclosure>
      </div>
    </StepShell>
  );
}

function ExtrasStep({ back, finish, finishing }: { back: () => void; finish: () => void; finishing: boolean }) {
  const doctor = useDoctor();
  const integrations = useIntegrations();
  const projects = useProjects();
  const repos = useRepos();
  const [open, setOpen] = useState(false);
  const gh = doctor.data?.checks.find((c) => c.id === 'gh');
  const asana = integrations.data?.find((i) => i.provider === 'asana');
  return (
    <StepShell
      title="Two extras, if you want them"
      description="Both are optional and only matter for Autopilot. You can set them up any time in Settings, under Connections."
      footer={
        <>
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
          <Button variant="primary" loading={finishing} onClick={finish}>
            Open the workspace
          </Button>
        </>
      }
    >
      <div className="divide-y divide-seam">
        <section className="pb-5">
          <h2 className="text-sm">GitHub</h2>
          <p className="mt-0.5 text-xs text-dust">Lets Autopilot open pull requests with your own GitHub login, only after you approve each one.</p>
          <div className="mt-3 text-sm">
            {!gh ? (
              <Loading label="Checking" />
            ) : gh.status === 'ok' ? (
              <p className="flex items-center gap-2">
                <Check className="size-4 shrink-0 text-go" aria-hidden /> {gh.detail}
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-dust">
                  {gh.detail} To connect, run <Code>gh auth login</Code> in a terminal, then check again. Without it, Autopilot keeps its finished work on this computer.
                </p>
                <Button size="sm" loading={doctor.isFetching} onClick={() => void doctor.refetch()}>
                  Check again
                </Button>
              </div>
            )}
          </div>
        </section>
        <section className="pt-5">
          <h2 className="text-sm">Asana</h2>
          <p className="mt-0.5 text-xs text-dust">Lets Autopilot pick up your Asana tasks and post its progress back on them.</p>
          <div className="mt-3">
            {asana ? (
              <div className="space-y-3 text-sm">
                <p className="flex items-center gap-2">
                  <Check className="size-4 shrink-0 text-go" aria-hidden /> Connected as {asana.account.name ?? asana.account.id}
                </p>
                {projects.data?.length ? (
                  <ul className="space-y-1">
                    {projects.data.map((p) => (
                      <li key={p.id} className="flex items-center gap-2">
                        <Check className="size-4 shrink-0 text-go" aria-hidden /> {p.name}
                        <span className="text-2xs text-dust">{p.repoIds.map((id) => repos.data?.find((r) => r.id === id)?.name).filter(Boolean).join(', ') || 'no projects chosen yet'}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <Button size="sm" onClick={() => setOpen(true)}>
                  Connect an Asana project
                </Button>
                {open ? <ConnectProjectDialog integrationId={asana.id} repos={repos.data ?? []} open={open} onOpenChange={setOpen} /> : null}
              </div>
            ) : (
              <AsanaConnectForm />
            )}
          </div>
        </section>
      </div>
    </StepShell>
  );
}

export function SetupPage() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const complete = useAction(() => patch('/api/settings', { onboarding: { completedAt: new Date().toISOString() } }), { invalidate: [keys.settings, keys.overview] });
  const done = () => complete.mutate(undefined, { onSuccess: () => navigate('/') });
  const go = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));

  return (
    <div className="min-h-dvh px-5 py-10 md:py-16">
      <div className="mx-auto grid max-w-[920px] gap-x-10 gap-y-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <div>
          <div className="mb-6 flex items-center gap-2.5 md:mb-8">
            <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
              <ellipse cx="16" cy="16" rx="12.5" ry="7" fill="none" stroke="var(--color-telemetry)" strokeWidth="1.5" transform="rotate(-24 16 16)" />
              <circle cx="16" cy="16" r="4.4" fill="var(--color-chalk)" />
              <circle cx="26.6" cy="11.2" r="2.4" fill="var(--color-signal)" />
            </svg>
            <span className="casual text-lg font-[700]">Orbit</span>
          </div>
          <ol className="flex gap-1 md:block md:space-y-1" aria-label="Setup steps">
            {STEPS.map((label, i) => (
              <li key={label}>
                <button
                  type="button"
                  onClick={() => i < step && go(i)}
                  className={cn('flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-sm', i === step ? 'bg-hull font-[600] text-chalk' : i < step ? 'text-chalk/80 hover:bg-hull/60' : 'text-dust')}
                  aria-current={i === step ? 'step' : undefined}
                  disabled={i > step}
                >
                  <span className={cn('grid size-5 shrink-0 place-items-center rounded-full text-2xs tabular', i < step ? 'bg-go/15 text-go' : i === step ? 'bg-signal text-signal-ink' : 'border border-seam-2')}>
                    {i < step ? <Check className="size-3" aria-label="Done" /> : i + 1}
                  </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="mt-6 px-2 text-xs text-dust underline decoration-seam-2 underline-offset-4 hover:text-chalk md:mt-8" onClick={done}>
            Skip setup
          </button>
        </div>
        <div className="min-w-0">
          {step === 0 ? <ProjectStep next={() => go(1)} /> : null}
          {step === 1 ? <AiStep next={() => go(2)} back={() => go(0)} /> : null}
          {step === 2 ? <ExtrasStep back={() => go(1)} finish={done} finishing={complete.isPending} /> : null}
        </div>
      </div>
      <Toaster />
    </div>
  );
}

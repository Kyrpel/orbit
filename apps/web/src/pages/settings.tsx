import { RadioGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import type { Settings } from '@orbit/shared';
import { Button, Code, Disclosure, ErrorNote, Input, Loading, PageHeader, Panel, PanelHeader, Switch } from '../components/ui';
import { keys, patch, post, useAction, useDoctor, useSession, useSettings, type SettingsPatch } from '../lib/api';
import { cn } from '../lib/utils';

/*
  General settings. The everyday choices come first, each in one plain sentence; limits and
  connection details that are rarely touched are folded away under Advanced, with their
  current values on the row so you can check them without opening anything.
*/

const SELECT = 'h-9 max-w-full rounded-[8px] border border-seam bg-hull px-3 text-sm text-chalk';

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4">
      <div className="min-w-0 max-w-[60ch] flex-1 basis-64">
        <p className="text-sm font-[600]">{title}</p>
        {description ? <p className="mt-0.5 text-xs text-dust">{description}</p> : null}
      </div>
      <div className="min-w-0 max-w-full">{children}</div>
    </div>
  );
}

export function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; description: ReactNode; disabled?: boolean }[] }) {
  return (
    <RadioGroup.Root value={value} onValueChange={(v) => onChange(v as T)} className="grid gap-2">
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn('flex items-start gap-3 rounded-[10px] border px-4 py-3 text-left transition-colors disabled:opacity-50', value === o.value ? 'border-signal/60 bg-signal/6' : 'border-seam hover:border-seam-2')}
        >
          <span className={cn('mt-1 grid size-3.5 shrink-0 place-items-center rounded-full border', value === o.value ? 'border-signal' : 'border-seam-2')}>
            <RadioGroup.Indicator className="size-1.5 rounded-full bg-signal" />
          </span>
          <span>
            <span className="block text-sm text-chalk">{o.label}</span>
            <span className="block text-xs text-dust">{o.description}</span>
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

function NumberInput({ value, onCommit, min, max, step = 1, suffix, label }: { value: number; onCommit: (n: number) => void; min: number; max: number; step?: number; suffix?: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Input
        type="number"
        className="w-24 tabular"
        aria-label={label}
        defaultValue={value}
        min={min}
        max={max}
        step={step}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n !== value) onCommit(Math.min(max, Math.max(min, n)));
        }}
      />
      {suffix ? <span className="text-xs text-dust">{suffix}</span> : null}
    </span>
  );
}

/** Claude Code's sandbox is not available on native Windows yet; say so before a task stops on it. */
export function WindowsSandboxNote({ platform, mode }: { platform: string | undefined; mode: Settings['execution']['mode'] }) {
  if (!platform?.startsWith('win32') || mode !== 'sandbox') return null;
  return (
    <div className="rounded-[10px] border border-signal/45 bg-signal/6 px-4 py-3 text-sm">
      <p className="font-[600]">The sandbox does not work on this Windows computer yet</p>
      <p className="mt-1 text-xs text-dust">
        Claude Code&apos;s sandbox is not available on Windows, so Autopilot tasks stop before the engineer starts. To use Autopilot here, choose &quot;Directly on this computer&quot; and
        allow commands. You still approve every change before it is saved, and every pull request before it is sent.
      </p>
    </div>
  );
}

export function useSaveSettings() {
  return useAction((p: SettingsPatch) => patch<Settings>('/api/settings', p), { success: 'Saved', invalidate: [keys.settings, keys.doctor, keys.overview] });
}

export function ConsentControl({ s }: { s: Settings }) {
  const consent = useAction((grant: boolean) => post<Settings>('/api/consent', { grant }), { success: (r) => (r.execution.localExecutionConsentAt ? 'Commands are allowed on this computer' : 'Permission withdrawn'), invalidate: [keys.settings, keys.doctor] });
  const given = !!s.execution.localExecutionConsentAt;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-[60ch] flex-1 basis-64">
        <p className="text-sm font-[600]">
          Let Autopilot run commands on this computer
          {given ? null : <span className="ml-2 rounded-full bg-signal/14 px-2 py-0.5 text-2xs font-[600] text-signal-deep">Needs your OK</span>}
        </p>
        <p className="mt-0.5 text-xs text-dust">
          To test its work, Autopilot runs your project&apos;s own commands (for example <Code>npm install</Code> and <Code>npm test</Code>) on code an AI wrote, with your permissions. It works
          in a separate copy of the project, but a copy is not a sandbox: a command can still reach the rest of this computer.
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Button size="sm" variant={given ? 'secondary' : 'primary'} loading={consent.isPending} onClick={() => consent.mutate(!given)}>
          {given ? 'Withdraw permission' : 'I understand, allow it'}
        </Button>
        {given ? <span className="text-2xs text-dust">Allowed on {new Date(s.execution.localExecutionConsentAt as string).toLocaleDateString()}</span> : null}
      </div>
    </div>
  );
}

const RUNTIME_LABEL: Record<Settings['execution']['runtime'], string> = {
  auto: 'Automatic',
  'claude-agent-sdk': 'An API key',
  'claude-code-cli': 'Claude Code on this computer',
  scripted: 'Demo without AI',
};

export function RuntimeChoice({ s, onChange }: { s: Settings; onChange: (r: Settings['execution']['runtime']) => void }) {
  const doctor = useDoctor();
  const status = (id: string) => doctor.data?.runtimes.find((r) => r.id === id);
  const label = (id: string) => {
    const r = status(id);
    return r ? (r.available ? 'Ready.' : `${r.reason ?? 'Not available.'}`) : '';
  };
  return (
    <Choice
      value={s.execution.runtime}
      onChange={onChange}
      options={[
        {
          value: 'auto',
          label: 'Automatic (recommended)',
          description: `Uses your Claude Code plan when Claude Code is installed and signed in, otherwise an API key. ${
            status('claude-code-cli')?.available ? 'Right now: your Claude Code plan.' : status('claude-agent-sdk')?.available ? 'Right now: your API key.' : ''
          }`,
        },
        {
          value: 'claude-code-cli',
          label: 'Claude Code on this computer',
          description: `Uses the Claude Code you already have, with your own login. Orbit never reads its credentials, and usage counts toward your Claude plan. ${label('claude-code-cli')}`,
        },
        { value: 'claude-agent-sdk', label: 'An API key', description: `Uses ANTHROPIC_API_KEY, or Bedrock, Vertex AI or Foundry credentials, from the environment Orbit was started in. ${label('claude-agent-sdk')}` },
        { value: 'scripted', label: 'Demo without AI', description: 'Makes a fixed, harmless change instead of real work, so you can try Autopilot from start to finish for free.' },
      ]}
    />
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const session = useSession();
  const doctor = useDoctor();
  const save = useSaveSettings();
  if (settings.isPending) return <Loading />;
  if (settings.error) return <ErrorNote error={settings.error} />;
  const s = settings.data;
  const x = s.execution;
  const set = (p: SettingsPatch) => save.mutate(p);
  const limits = [`${x.agentTimeoutMinutes} min per agent`, x.maxBudgetUsdPerRun ? `$${x.maxBudgetUsdPerRun} per run` : 'no spending limit', `${x.maxFixIterations} fix ${x.maxFixIterations === 1 ? 'attempt' : 'attempts'}`];

  return (
    <>
      <PageHeader title="General" description="How Orbit behaves. Every change is saved right away." />
      <div className="space-y-6">
        <Panel>
          <PanelHeader title="Workspace sessions" />
          <div className="divide-y divide-seam">
            <Row title="When the AI wants to run a command" description="The starting choice for new sessions. You can change it in any session, under the message box.">
              <select aria-label="When the AI wants to run a command" className={SELECT} value={x.sessionCommands} onChange={(e) => set({ execution: { sessionCommands: e.target.value as 'ask' | 'auto' } })}>
                <option value="ask">Ask me first</option>
                <option value="auto">Run it (risky ones stay blocked)</option>
              </select>
            </Row>
            <Row title="Follow-up messages" description="Your original request stays active. New messages add instructions to the same task, so the AI works on both. Additions are picked up at its next completed step. Applies to existing and new sessions.">
              <select aria-label="Follow-up messages" className={SELECT} value={x.sessionFollowUps} onChange={(e) => set({ execution: { sessionFollowUps: e.target.value as Settings['execution']['sessionFollowUps'] } })}>
                <option value="send">Add to current task (default)</option>
                <option value="queue">Wait until finished</option>
              </select>
            </Row>
            <Row title="Suggest my next message" description="After each answer, a likely next message appears greyed out in the message box. Press Tab to use it.">
              <Switch checked={x.suggestNext} onCheckedChange={(v) => set({ execution: { suggestNext: v } })} label="Suggest my next message" />
            </Row>
            <Row
              title="Use my Claude Code and Codex history"
              description="The AI can look up what you did in Claude Code or Codex outside Orbit, in any folder, and continue from it with /past and /resume. Short notes of those sessions stay on this computer."
            >
              <Switch checked={x.pastSessions} onCheckedChange={(v) => set({ execution: { pastSessions: v } })} label="Use my Claude Code and Codex history" />
            </Row>
            <Row title="Let the AI use the web" description="Off unless you turn it on. Lets agents search and read web pages. Applies from the next message.">
              <Switch checked={x.allowAgentNetwork} onCheckedChange={(v) => set({ execution: { allowAgentNetwork: v } })} label="Let the AI use the web" />
            </Row>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Autopilot" description="You always review the result and approve each pull request. Orbit never merges." />
          <div className="divide-y divide-seam">
            <Row title="Show me the plan before building" description="Autopilot can start right away when the task is clear, or always wait for your OK on the plan.">
              <select aria-label="Show me the plan before building" className={SELECT} value={s.approvals.scope} onChange={(e) => set({ approvals: { scope: e.target.value as Settings['approvals']['scope'] } })}>
                <option value="when-ambiguous">Only when something is unclear</option>
                <option value="always">Always</option>
              </select>
            </Row>
            <Row title="Where the engineer's commands run" description={x.mode === 'sandbox' ? "Inside Claude Code's sandbox. If the sandbox is not available, the task stops and says why." : 'Directly on this computer, with your permissions. Needs the permission below.'}>
              <select aria-label="Where the engineer's commands run" className={SELECT} value={x.mode} onChange={(e) => set({ execution: { mode: e.target.value as Settings['execution']['mode'] } })}>
                <option value="sandbox">In a sandbox</option>
                <option value="trusted-local">Directly on this computer</option>
              </select>
            </Row>
            <div className="space-y-4 px-5 py-4">
              <WindowsSandboxNote platform={doctor.data?.platform} mode={x.mode} />
              <ConsentControl s={s} />
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Advanced" description="Rarely needed. The current values are shown on each row." />
          <div className="divide-y divide-seam">
            <Disclosure title="How Orbit reaches Claude" summary={`${RUNTIME_LABEL[x.runtime]}. Codex uses its own login.`}>
              <div className="px-5 pb-5">
                <RuntimeChoice s={s} onChange={(runtime) => set({ execution: { runtime } })} />
              </div>
            </Disclosure>
            <Disclosure title="Limits for Autopilot" summary={limits.join(' · ')}>
              <div className="divide-y divide-seam border-t border-seam">
                <Row title="Tasks at the same time" description="How many tasks may have an agent working at once.">
                  <NumberInput label="Tasks at the same time" value={x.maxConcurrentMissions} min={1} max={8} onCommit={(n) => set({ execution: { maxConcurrentMissions: n } })} />
                </Row>
                <Row title="Automatic fix attempts" description="When a check fails or a reviewer finds a problem, the engineer tries again this many times before handing it to you.">
                  <NumberInput label="Automatic fix attempts" value={x.maxFixIterations} min={0} max={5} onCommit={(n) => set({ execution: { maxFixIterations: n } })} />
                </Row>
                <Row title="Spending limit per agent run" description="An agent stops when its estimated cost reaches this. 0 means no limit.">
                  <NumberInput label="Spending limit per agent run" value={x.maxBudgetUsdPerRun ?? 0} min={0} max={500} step={0.5} suffix="USD" onCommit={(n) => set({ execution: { maxBudgetUsdPerRun: n || null } })} />
                </Row>
                <Row title="Time limit per agent">
                  <NumberInput label="Time limit per agent" value={x.agentTimeoutMinutes} min={1} max={240} suffix="minutes" onCommit={(n) => set({ execution: { agentTimeoutMinutes: n } })} />
                </Row>
                <Row title="Time limit per command" description="For each of your project's install and test commands.">
                  <NumberInput label="Time limit per command" value={x.commandTimeoutMinutes} min={1} max={120} suffix="minutes" onCommit={(n) => set({ execution: { commandTimeoutMinutes: n } })} />
                </Row>
                <Row title="Steps per agent run" description="An agent stops after this many steps, so it cannot loop forever.">
                  <NumberInput label="Steps per agent run" value={x.maxTurns} min={5} max={500} onCommit={(n) => set({ execution: { maxTurns: n } })} />
                </Row>
              </div>
            </Disclosure>
            <Disclosure title="Asana and GitHub" summary={`Asana is checked every ${s.asana.pollIntervalSeconds} seconds · pull requests open ${s.github.draftPullRequests ? 'as drafts' : 'ready for review'}`}>
              <div className="divide-y divide-seam border-t border-seam">
                <Row title="Check Asana for /orbit run comments every">
                  <NumberInput label="Check Asana every" value={s.asana.pollIntervalSeconds} min={10} max={3600} suffix="seconds" onCommit={(n) => set({ asana: { pollIntervalSeconds: n } })} />
                </Row>
                <Row title="Progress comments on Asana tasks" description="Only the important ones: a plan that needs your OK, a pull request, a problem. Or every step.">
                  <select aria-label="Progress comments on Asana tasks" className={SELECT} value={s.asana.commentVerbosity} onChange={(e) => set({ asana: { commentVerbosity: e.target.value as 'minimal' | 'normal' } })}>
                    <option value="normal">Every step</option>
                    <option value="minimal">Only the important ones</option>
                  </select>
                </Row>
                <Row title="Asana requests per minute" description="Asana allows 150 on free plans and 1,500 on paid plans.">
                  <NumberInput label="Asana requests per minute" value={s.asana.requestsPerMinute} min={10} max={1500} onCommit={(n) => set({ asana: { requestsPerMinute: n } })} />
                </Row>
                <Row title="Open pull requests as drafts">
                  <Switch checked={s.github.draftPullRequests} onCheckedChange={(v) => set({ github: { draftPullRequests: v } })} label="Open pull requests as drafts" />
                </Row>
                <Row title="Link the task in public projects" description="Off unless you turn it on, so private task titles and links never appear in public pull requests.">
                  <Switch checked={s.github.includeSourceInPublicRepos} onCheckedChange={(v) => set({ github: { includeSourceInPublicRepos: v } })} label="Link the task in public projects" />
                </Row>
              </div>
            </Disclosure>
            <Row title="Where Orbit keeps its data" description="Sessions, settings, the work copies Autopilot makes and your saved keys. Nothing leaves this computer except what you send to your AI, Asana and GitHub.">
              <Code className="break-all">{session.data?.home ?? '…'}</Code>
            </Row>
          </div>
        </Panel>
      </div>
    </>
  );
}

import { RadioGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Settings } from '@orbit/shared';
import { Button, Code, ErrorNote, Input, Loading, PageHeader, Panel, PanelHeader, Switch } from '../components/ui';
import { keys, patch, post, useAction, useAgents, useDoctor, useSession, useSettings, type SettingsPatch } from '../lib/api';
import { ProviderBadge } from '../components/provider';
import { cn } from '../lib/utils';

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0 max-w-[60ch]">
        <p className="text-sm font-[560]">{title}</p>
        {description ? <p className="mt-0.5 text-xs text-dust">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
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
          className={cn(
            'flex items-start gap-3 rounded-[10px] border px-4 py-3 text-left transition-colors disabled:opacity-50',
            value === o.value ? 'border-signal/60 bg-signal/6' : 'border-seam hover:border-seam-2',
          )}
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

function NumberInput({ value, onCommit, min, max, step = 1, suffix }: { value: number; onCommit: (n: number) => void; min: number; max: number; step?: number; suffix?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Input
        type="number"
        className="w-24 tabular"
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

/** Claude Code's OS sandbox is not available on native Windows yet; say so before a mission stops on it. */
export function WindowsSandboxNote({ platform, mode }: { platform: string | undefined; mode: Settings['execution']['mode'] }) {
  if (!platform?.startsWith('win32') || mode !== 'sandbox') return null;
  return (
    <div className="rounded-[10px] border border-signal/45 bg-signal/6 px-4 py-3 text-sm">
      <p className="font-[600]">Sandboxed agents cannot run on this Windows machine yet</p>
      <p className="mt-1 text-xs text-dust">
        Claude Code&apos;s sandbox is not active on native Windows, so missions in sandbox mode stop before the engineer starts. To run missions here, choose Trusted-local
        below and give consent. You still approve every change before it is committed and every pull request before it is pushed.
      </p>
    </div>
  );
}

/** Every agent at a glance: what it does and which AI it runs on right now. */
function AgentsSummary() {
  const agents = useAgents();
  return (
    <Panel>
      <PanelHeader
        title="Your agents"
        description="Six agents, each with one job. Change which AI each one uses, its model and effort on the Agents page."
        action={
          <Link to="/agents">
            <Button size="sm">Manage agents</Button>
          </Link>
        }
      />
      {agents.isPending ? (
        <Loading label="Loading your agents" />
      ) : agents.error ? (
        <div className="p-4">
          <ErrorNote error={agents.error} />
        </div>
      ) : (
        <ul className="grid divide-seam sm:grid-cols-2 sm:divide-x">
          {agents.data.map((a) => (
            <li key={a.role} className="border-b border-seam px-5 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-[650]">{a.title}</span>
                {a.resolved.available ? <ProviderBadge provider={a.resolved.provider} model={a.resolved.model} /> : <span className="text-2xs text-signal-deep">Not ready</span>}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-dust">{a.description}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function useSaveSettings() {
  return useAction((p: SettingsPatch) => patch<Settings>('/api/settings', p), { success: 'Settings saved', invalidate: [keys.settings, keys.doctor, keys.overview] });
}

export function ConsentControl({ s }: { s: Settings }) {
  const consent = useAction((grant: boolean) => post<Settings>('/api/consent', { grant }), { success: (r) => (r.execution.localExecutionConsentAt ? 'Local command execution allowed' : 'Consent withdrawn'), invalidate: [keys.settings, keys.doctor] });
  const given = !!s.execution.localExecutionConsentAt;
  return (
    <div className={cn('rounded-[10px] border px-4 py-3', given ? 'border-seam' : 'border-signal/45 bg-signal/6')}>
      <p className="text-sm font-[600]">Allow commands on this machine</p>
      <p className="mt-1 max-w-[70ch] text-xs text-dust">
        Setup and verification commands (for example <Code>pnpm install</Code> and <Code>pnpm test</Code>) run your repository&apos;s scripts against code an agent wrote, with your user
        permissions, in the mission worktree. In trusted-local mode, agents also run commands directly on this machine. Git worktrees are not a sandbox.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant={given ? 'secondary' : 'primary'} loading={consent.isPending} onClick={() => consent.mutate(!given)}>
          {given ? 'Withdraw consent' : 'I understand, allow it'}
        </Button>
        {given ? <span className="text-xs text-dust">Allowed {new Date(s.execution.localExecutionConsentAt as string).toLocaleString()}</span> : null}
      </div>
    </div>
  );
}

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
          description: `Uses your Claude Code plan when Claude Code is installed and signed in; otherwise an API key from Orbit's environment. ${
            doctor.data?.runtimes.find((r) => r.id === 'claude-code-cli')?.available
              ? 'Right now: your Claude Code plan.'
              : doctor.data?.runtimes.find((r) => r.id === 'claude-agent-sdk')?.available
                ? 'Right now: your API key.'
                : ''
          }`,
        },
        { value: 'claude-agent-sdk', label: 'Claude Agent SDK', description: `Uses ANTHROPIC_API_KEY or Bedrock, Vertex AI or Foundry credentials from Orbit's environment. ${label('claude-agent-sdk')}` },
        {
          value: 'claude-code-cli',
          label: 'Claude Code CLI on this machine',
          description: `Runs your installed claude in headless mode with your own login. Orbit never reads its credentials; usage counts toward your Claude plan. ${label('claude-code-cli')}`,
        },
        { value: 'scripted', label: 'Scripted demo (no AI)', description: 'Writes ORBIT_DEMO.md instead of real changes, so you can try worktrees, checks, approvals and pull requests for free.' },
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
  const set = (p: SettingsPatch) => save.mutate(p);

  return (
    <>
      <PageHeader title="Settings" description="Your agents, how they connect to Claude and Codex, what they may do without asking, and how they report back." />
      <div className="space-y-6">
        <AgentsSummary />
        <Panel>
          <PanelHeader title="Claude connection" description="How Orbit reaches Claude for every seat that uses Claude. Codex is connected through its own login; see the Agents page." />
          <div className="px-5 py-4">
            <RuntimeChoice s={s} onChange={(runtime) => set({ execution: { runtime } })} />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Execution safety" />
          <div className="space-y-4 px-5 py-4">
            <WindowsSandboxNote platform={doctor.data?.platform} mode={s.execution.mode} />
            <Choice
              value={s.execution.mode}
              onChange={(mode) => set({ execution: { mode } })}
              options={[
                { value: 'sandbox', label: 'Sandboxed agents', description: "The engineer's commands must run inside Claude Code's OS sandbox. If the sandbox is unavailable on this machine, missions stop and explain why." },
                { value: 'trusted-local', label: 'Trusted-local agents', description: 'The engineer runs commands directly on this machine with your permissions. Requires the consent below. Not a sandbox.' },
              ]}
            />
            <ConsentControl s={s} />
          </div>
          <div className="divide-y divide-seam border-t border-seam">
            <Row
              title="Commands in new workspace sessions"
              description="Ask first: the agent asks before running any command that changes things. Auto-accept: commands run on their own like Claude Code's auto mode, and a safety check blocks risky ones. You can switch each session in its tab."
            >
              <select
                aria-label="Commands in new workspace sessions"
                className="h-9 rounded-[8px] border border-seam bg-hull px-3 text-sm"
                value={s.execution.sessionCommands}
                onChange={(e) => set({ execution: { sessionCommands: e.target.value as 'ask' | 'auto' } })}
              >
                <option value="ask">Ask first</option>
                <option value="auto">Auto-accept (safety-checked)</option>
              </select>
            </Row>
            <Row title="Allow agents to use the web" description="WebFetch and WebSearch are off by default: task text is untrusted, and the web is an easy way to leak code.">
              <Switch checked={s.execution.allowAgentNetwork} onCheckedChange={(v) => set({ execution: { allowAgentNetwork: v } })} label="Allow agent web access" />
            </Row>
            <Row title="Missions at the same time" description="How many missions may have an agent working at once.">
              <NumberInput value={s.execution.maxConcurrentMissions} min={1} max={8} onCommit={(n) => set({ execution: { maxConcurrentMissions: n } })} />
            </Row>
            <Row title="Automatic fix passes" description="When checks fail or the reviewer finds blocking issues, the engineer retries up to this many times before handing it to you.">
              <NumberInput value={s.execution.maxFixIterations} min={0} max={5} onCommit={(n) => set({ execution: { maxFixIterations: n } })} />
            </Row>
            <Row title="Budget per agent run" description="Hard stop on estimated model spend for a single planner, engineer or reviewer run.">
              <NumberInput value={s.execution.maxBudgetUsdPerRun ?? 0} min={0} max={500} step={0.5} suffix="USD" onCommit={(n) => set({ execution: { maxBudgetUsdPerRun: n || null } })} />
            </Row>
            <Row title="Agent time limit">
              <NumberInput value={s.execution.agentTimeoutMinutes} min={1} max={240} suffix="minutes" onCommit={(n) => set({ execution: { agentTimeoutMinutes: n } })} />
            </Row>
            <Row title="Command time limit" description="Applies to each setup or verification command.">
              <NumberInput value={s.execution.commandTimeoutMinutes} min={1} max={120} suffix="minutes" onCommit={(n) => set({ execution: { commandTimeoutMinutes: n } })} />
            </Row>
            <Row title="Turn limit per agent run">
              <NumberInput value={s.execution.maxTurns} min={5} max={500} onCommit={(n) => set({ execution: { maxTurns: n } })} />
            </Row>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Models, effort and which AI each agent uses"
            description="Planner, Engineer, Reviewer and Assistant each have their own AI, model and effort. Set them on the AI team page."
            action={
              <Link to="/agents">
                <Button size="sm">Open AI team</Button>
              </Link>
            }
          />
        </Panel>

        <Panel>
          <PanelHeader title="Approvals" />
          <div className="px-5 py-4">
            <Choice
              value={s.approvals.scope}
              onChange={(scope) => set({ approvals: { scope } })}
              options={[
                { value: 'when-ambiguous', label: 'Ask about scope only when needed', description: 'One mapped repository, a verified trigger and no open questions start right away. Everything else waits for you.' },
                { value: 'always', label: 'Always ask before implementation starts', description: 'Every mission stops after planning until you approve the scope.' },
              ]}
            />
            <p className="mt-3 text-xs text-dust">Reviewing changes and approving each pull request are always required. Orbit never merges.</p>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Asana and GitHub" />
          <div className="divide-y divide-seam">
            <Row title="Check Asana for /orbit commands every">
              <NumberInput value={s.asana.pollIntervalSeconds} min={10} max={3600} suffix="seconds" onCommit={(n) => set({ asana: { pollIntervalSeconds: n } })} />
            </Row>
            <Row title="Progress comments on Asana tasks" description="Minimal posts only plans that need approval, pull requests, blocks and failures.">
              <select className="h-9 rounded-[8px] border border-seam bg-night px-3 text-sm" value={s.asana.commentVerbosity} onChange={(e) => set({ asana: { commentVerbosity: e.target.value as 'minimal' | 'normal' } })}>
                <option value="normal">Every milestone</option>
                <option value="minimal">Minimal</option>
              </select>
            </Row>
            <Row title="Requests per minute" description="Asana allows 150 on free plans and 1,500 on paid plans.">
              <NumberInput value={s.asana.requestsPerMinute} min={10} max={1500} onCommit={(n) => set({ asana: { requestsPerMinute: n } })} />
            </Row>
            <Row title="Open pull requests as drafts">
              <Switch checked={s.github.draftPullRequests} onCheckedChange={(v) => set({ github: { draftPullRequests: v } })} label="Draft pull requests" />
            </Row>
            <Row title="Include task links in public repositories" description="Off by default, so private task titles and links never appear in public pull requests.">
              <Switch checked={s.github.includeSourceInPublicRepos} onCheckedChange={(v) => set({ github: { includeSourceInPublicRepos: v } })} label="Include task links in public repositories" />
            </Row>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Data" />
          <Row title="Orbit data folder" description="Database, worktrees, cloned repositories and tokens. Nothing is sent anywhere except the AI runtime, Asana and GitHub actions you approve.">
            <Code>{session.data?.home ?? '…'}</Code>
          </Row>
        </Panel>
      </div>
    </>
  );
}

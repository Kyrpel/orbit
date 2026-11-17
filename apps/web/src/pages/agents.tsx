import { AlertTriangle, Check } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { EFFORT_INFO, EFFORT_LEVELS, formatDuration, formatUsd, type AgentRoleDTO, type EffortLevel, type ProviderStatusDTO, type Settings, type TeamDTO } from '@orbit/shared';
import { CursorCard } from '../components/cursor-card';
import { HuggingFaceCard } from '../components/hf-card';
import { OpenRouterCard } from '../components/openrouter-card';
import { PROVIDER_NAME, PROVIDER_TEXT, ProviderBadge } from '../components/provider';
import { Button, Code, Disclosure, ErrorNote, Loading, PageHeader, Panel, PanelHeader, Switch, Tag } from '../components/ui';
import { keys, patch, useAction, useAgents, useSettings, useTeam, type SettingsPatch } from '../lib/api';
import { cn, timeAgo } from '../lib/utils';

/*
  Agents: who does what, and on which AI. Each agent is one line (its job and the AI it runs
  on right now); its choices open underneath. Below them, the AIs you have connected.
*/

function useSave() {
  return useAction((p: SettingsPatch) => patch<Settings>('/api/settings', p), { success: 'Saved', invalidate: [keys.agents, keys.team, keys.settings, keys.doctor, keys.overview] });
}

const SELECT = 'h-8 rounded-[8px] border border-seam bg-hull px-2.5 text-xs text-chalk';

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function AgentRow({ a, team }: { a: AgentRoleDTO; team: TeamDTO }) {
  const save = useSave();
  const [showRuns, setShowRuns] = useState(false);
  const claude = team.providers.find((p) => p.provider === 'claude');
  const codex = team.providers.find((p) => p.provider === 'codex');
  const r = a.resolved;
  const options: { value: AgentRoleDTO['provider']; label: string; disabled?: boolean }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'claude', label: 'Claude', disabled: !claude },
    { value: 'codex', label: 'Codex', disabled: !codex },
  ];
  const plan = a.recentRuns.some((x) => x.runtime === 'claude-code-cli');
  const label = 'w-14 shrink-0 text-xs text-dust';

  return (
    <Disclosure
      title={a.title}
      summary={a.description}
      trailing={r.available ? <ProviderBadge provider={r.provider} model={r.model ?? (r.provider === 'codex' ? 'default model' : null)} className="hidden shrink-0 sm:inline-flex" /> : <span className="shrink-0 text-2xs font-[600] text-signal-deep">Not ready</span>}
    >
      <div className="space-y-3 border-t border-seam bg-night/50 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className={label}>AI</span>
          <div className="inline-flex rounded-[8px] bg-hull-3 p-0.5" role="radiogroup" aria-label={`AI for the ${a.title}`}>
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={a.provider === o.value}
                disabled={o.disabled || save.isPending}
                onClick={() => save.mutate({ team: { [a.role]: o.value } })}
                className={cn('h-7 rounded-[6px] px-3 text-xs transition-colors disabled:opacity-50', a.provider === o.value ? 'bg-hull font-[600] text-chalk shadow-[0_1px_2px_rgb(16_24_40/0.1)]' : 'text-dust hover:text-chalk')}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="min-w-0 flex-1 basis-56 text-xs text-dust">
            {r.why}
            {r.fallback ? (
              <>
                {' '}
                If it reaches its usage limit, <span className={PROVIDER_TEXT[r.fallback.provider]}>{PROVIDER_NAME[r.fallback.provider]}</span> takes over.
              </>
            ) : null}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className={label}>Model</span>
          {claude ? (
            <label className="inline-flex items-center gap-1.5 text-xs text-dust">
              <span className="text-claude">Claude</span>
              <select className={SELECT} value={claude.models.some((m) => m.id === a.model) ? a.model : '__custom'} onChange={(e) => e.target.value !== '__custom' && save.mutate({ models: { [a.role]: e.target.value } })} aria-label={`Claude model for the ${a.title}`}>
                {claude.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label.replace(/^Claude /, '')}
                  </option>
                ))}
                {!claude.models.some((m) => m.id === a.model) ? <option value="__custom">{a.model}</option> : null}
              </select>
            </label>
          ) : null}
          {codex ? (
            <label className="inline-flex items-center gap-1.5 text-xs text-dust">
              <span className="text-codex">Codex</span>
              <select className={SELECT} value={a.codexModel ?? ''} onChange={(e) => save.mutate({ codexModels: { [a.role]: e.target.value || null } })} aria-label={`Codex model for the ${a.title}`}>
                <option value="">Codex default</option>
                {codex.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                {a.codexModel && !codex.models.some((m) => m.id === a.codexModel) ? <option value={a.codexModel}>{a.codexModel}</option> : null}
              </select>
            </label>
          ) : null}
          {!claude && !codex ? <span className="text-xs text-dust">Connect Claude or Codex below to choose a model.</span> : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className={label}>Effort</span>
          <select className={SELECT} value={a.effort} onChange={(e) => save.mutate({ efforts: { [a.role]: e.target.value as EffortLevel } })} aria-label={`Effort for the ${a.title}`}>
            {EFFORT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {EFFORT_INFO[l].label}
              </option>
            ))}
          </select>
          <span className="min-w-0 flex-1 basis-56 text-xs text-dust">{EFFORT_INFO[a.effort].description}</span>
        </div>

        {a.role === 'assistant' ? (
          <p className="text-xs text-dust">
            This is the agent you talk to in the{' '}
            <Link to="/" className="text-chalk underline decoration-seam-2 underline-offset-4 hover:decoration-chalk">
              Workspace
            </Link>
            . Each session can also pick its own AI under the message box.
          </p>
        ) : a.stats.runs ? (
          <div className="text-xs text-dust">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="tabular">
                {a.stats.runs} {a.stats.runs === 1 ? 'run' : 'runs'}, {a.stats.succeeded} finished{a.stats.failed ? `, ${a.stats.failed} failed` : ''}
              </span>
              {a.stats.avgDurationMs != null ? <span className="tabular">typically {formatDuration(a.stats.avgDurationMs)}</span> : null}
              {a.stats.totalCostUsd ? <span className="tabular">{plan ? `about ${formatUsd(a.stats.totalCostUsd)} of plan usage at API prices` : formatUsd(a.stats.totalCostUsd)}</span> : null}
              {a.recentRuns.length ? (
                <button type="button" className="text-chalk underline decoration-seam-2 underline-offset-4 hover:decoration-chalk" onClick={() => setShowRuns(!showRuns)} aria-expanded={showRuns}>
                  {showRuns ? 'Hide recent runs' : 'Show recent runs'}
                </button>
              ) : null}
            </div>
            {showRuns ? (
              <ul className="mt-2 divide-y divide-seam rounded-[8px] border border-seam bg-hull">
                {a.recentRuns.map((run) => (
                  <li key={run.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <Link to={`/missions/${run.missionId}`} className="min-w-0 flex-1 truncate text-chalk/90 hover:underline">
                      {run.missionTitle}
                    </Link>
                    <ProviderBadge provider={run.runtime === 'codex-cli' ? 'codex' : run.runtime === 'scripted' ? 'scripted' : 'claude'} quiet />
                    <Tag tone={run.status === 'succeeded' ? 'success' : run.status === 'running' ? 'active' : run.status === 'cancelled' ? 'neutral' : 'danger'}>{run.status}</Tag>
                    <span className="w-14 text-right text-dust">{timeAgo(run.startedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// The AIs you connected
// ---------------------------------------------------------------------------

/** Claude and Codex: ready, or the one command that makes them ready. */
function ProviderRow({ p }: { p: ProviderStatusDTO }) {
  const fix = p.provider === 'codex' ? ['npm install -g @openai/codex', 'codex login'] : ['claude'];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3.5">
      <div className="min-w-0 flex-1 basis-64">
        <p className="flex items-center gap-2 text-sm font-[600]">
          <span className={cn('size-2 shrink-0 rounded-full bg-current', PROVIDER_TEXT[p.provider])} aria-hidden />
          {p.label}
        </p>
        {p.available ? (
          <p className="mt-0.5 text-xs text-dust">{[p.details.version, p.details.authMethod ? `signed in with ${p.details.authMethod}` : null].filter(Boolean).join(', ') || 'Connected'}</p>
        ) : (
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-dust">
            {p.reason ?? 'Not available.'} To connect it, run in a terminal:
            {fix.map((c) => (
              <Code key={c}>{c}</Code>
            ))}
          </p>
        )}
      </div>
      {p.available ? (
        <Tag tone="success">
          <Check className="size-3" aria-hidden /> Ready
        </Tag>
      ) : (
        <Tag tone="neutral">Not connected</Tag>
      )}
    </div>
  );
}

function Toggle({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-6 px-5 py-4">
      <div>
        <p className="text-sm font-[600]">{title}</p>
        <p className="mt-0.5 max-w-[62ch] text-xs text-dust">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={title} />
    </div>
  );
}

function AiPanel({ team, seats }: { team: TeamDTO; seats: AgentRoleDTO[] }) {
  const save = useSave();
  const usesCodex = seats.some((s) => s.resolved.provider === 'codex' || s.resolved.fallback?.provider === 'codex');
  return (
    <Panel>
      <PanelHeader title="Your AIs" description="Orbit uses the AI tools you already have, with your own logins. It never sees or stores their passwords." />
      <div className="divide-y divide-seam">
        {team.providers.map((p) => (
          <ProviderRow key={p.provider} p={p} />
        ))}
        {team.openrouter ? <OpenRouterCard status={team.openrouter} /> : null}
        {team.huggingface ? <HuggingFaceCard status={team.huggingface} /> : null}
        {team.cursor ? <CursorCard status={team.cursor} /> : null}
        {team.worktrees.codexBlocked && usesCodex ? (
          <div className="flex flex-wrap items-start gap-3 bg-signal/[0.06] px-5 py-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-signal-deep" aria-hidden />
            <div className="min-w-0 flex-1 basis-64">
              <p className="font-[600]">Codex cannot run your tests where Orbit keeps its work copies</p>
              <p className="mt-0.5 text-xs text-dust">
                On Windows, Codex blocks Node and similar tools inside your user folder (<span className="mono">{team.worktrees.root}</span>). Moving the work copies fixes it. Your projects stay where they are.
              </p>
            </div>
            {team.worktrees.suggestedRoot ? (
              <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate({ execution: { worktreeRoot: team.worktrees.suggestedRoot } })}>
                Use {team.worktrees.suggestedRoot}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

export function AgentsPage() {
  const agents = useAgents();
  const team = useTeam();
  const settings = useSettings();
  const save = useSave();
  if (agents.isPending || team.isPending) return <Loading label="Loading your agents" />;
  if (agents.error || team.error) return <ErrorNote error={agents.error ?? team.error} />;
  return (
    <>
      <PageHeader title="Agents" description="Six agents, each with one job. On Auto, Orbit gives each job to the AI that suits it, and has a different AI review what another one wrote." />
      <div className="space-y-6">
        <Panel>
          <div className="divide-y divide-seam">
            {agents.data.map((a) => (
              <AgentRow key={a.role} a={a} team={team.data} />
            ))}
          </div>
        </Panel>

        <AiPanel team={team.data} seats={agents.data} />

        <Panel>
          <div className="divide-y divide-seam">
            <Toggle
              title="Switch AI automatically"
              description="When an agent's AI is not ready or reaches its usage limit, Orbit hands that step to another AI and says so. Your work keeps moving."
              checked={team.data.fallback}
              onChange={(v) => save.mutate({ team: { fallback: v } })}
            />
            <Toggle
              title="Security check on every Autopilot task"
              description="The security reviewer reads each change for leaked passwords and keys, unsafe input handling and risky packages, before you see it."
              checked={settings.data?.team.securityReview ?? true}
              onChange={(v) => save.mutate({ team: { securityReview: v } })}
            />
          </div>
        </Panel>
      </div>
    </>
  );
}

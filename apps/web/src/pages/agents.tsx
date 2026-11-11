import { AlertTriangle, ArrowRight, Check, ClipboardList, Hammer, MessageCircle, ShieldAlert, ShieldCheck, Wand2, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { EFFORT_INFO, EFFORT_LEVELS, formatDuration, formatUsd, type AgentRoleDTO, type EffortLevel, type ProviderStatusDTO, type Settings, type TeamDTO, type TeamSeat } from '@orbit/shared';
import { HuggingFaceCard } from '../components/hf-card';
import { OpenRouterCard } from '../components/openrouter-card';
import { PROVIDER_NAME, PROVIDER_TEXT, ProviderBadge } from '../components/provider';
import { Button, Code, ErrorNote, Loading, PageHeader, Panel, PanelHeader, Switch, Tag } from '../components/ui';
import { keys, patch, useAction, useAgents, useSettings, useTeam, type SettingsPatch } from '../lib/api';
import { cn, timeAgo } from '../lib/utils';

const SEAT_ICON: Record<TeamSeat, LucideIcon> = { planner: ClipboardList, engineer: Hammer, reviewer: ShieldCheck, security: ShieldAlert, prompter: Wand2, assistant: MessageCircle };

function useSave() {
  return useAction((p: SettingsPatch) => patch<Settings>('/api/settings', p), { success: 'Saved', invalidate: [keys.agents, keys.team, keys.settings, keys.doctor, keys.overview] });
}

const selectClass = 'h-8 rounded-[7px] border border-seam bg-night px-2.5 text-xs text-chalk';

// ---------------------------------------------------------------------------
// How work flows, with the AI in each seat
// ---------------------------------------------------------------------------

function FlowStrip({ seats, security }: { seats: AgentRoleDTO[]; security: boolean }) {
  const by = (r: TeamSeat) => seats.find((s) => s.role === r);
  const node = (label: string, who: string, seat: AgentRoleDTO | undefined) => (
    <li className="min-w-0 flex-1 rounded-[12px] border border-seam bg-hull px-3 py-2.5">
      <p className="text-sm font-[650]">{label}</p>
      <p className="text-2xs text-dust">{who}</p>
      {seat ? <ProviderBadge provider={seat.resolved.provider} model={seat.resolved.model} className="mt-1.5" /> : <p className="mt-1.5 text-2xs text-dust">Runs your tests</p>}
    </li>
  );
  const arrow = (
    <li aria-hidden className="hidden self-center md:block">
      <ArrowRight className="size-4 text-dust-2" />
    </li>
  );
  return (
    <Panel className="mb-6">
      <PanelHeader title="How Autopilot works" description="Each step goes to the agent and the AI best suited to it. Working sessions in the workspace use the session agent." />
      <ol className="flex flex-col gap-2 px-5 pb-5 md:flex-row">
        {node('Plan', 'Planner', by('planner'))}
        {arrow}
        {node('Build', 'Engineer', by('engineer'))}
        {arrow}
        {node('Check', 'Orbit', undefined)}
        {arrow}
        {node('Review', 'Reviewer', by('reviewer'))}
        {security ? (
          <>
            {arrow}
            {node('Security', 'Security reviewer', by('security'))}
          </>
        ) : null}
        {arrow}
        <li className="min-w-0 flex-1 rounded-[12px] border border-signal/50 bg-signal/[0.08] px-3 py-2.5">
          <p className="text-sm font-[650]">You approve</p>
          <p className="text-2xs text-signal-deep">Nothing is committed or pushed without you</p>
        </li>
      </ol>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Connected AIs
// ---------------------------------------------------------------------------

function ProviderCard({ p }: { p: ProviderStatusDTO }) {
  const fix = p.provider === 'codex' ? ['npm install -g @openai/codex', 'codex login'] : ['claude'];
  return (
    <div className="rounded-[10px] border border-seam px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={cn('size-2 rounded-full bg-current', PROVIDER_TEXT[p.provider])} aria-hidden />
        <span className="font-[620]">{p.label}</span>
        {p.available ? (
          <Tag tone="success" className="ml-auto">
            <Check className="size-3" aria-hidden /> Ready
          </Tag>
        ) : (
          <Tag tone="neutral" className="ml-auto">
            Not connected
          </Tag>
        )}
      </div>
      {p.available ? (
        <p className="mt-1.5 text-2xs text-dust">
          {[p.details.version, p.details.authMethod ? `signed in with ${p.details.authMethod}` : null].filter(Boolean).join(', ') || 'Connected'}
        </p>
      ) : (
        <div className="mt-1.5 space-y-1.5 text-2xs text-dust">
          <p>{p.reason ?? 'Not available.'}</p>
          <p className="flex flex-wrap items-center gap-1.5">
            In a terminal:
            {fix.map((c) => (
              <Code key={c}>{c}</Code>
            ))}
          </p>
        </div>
      )}
    </div>
  );
}

function TeamPanel({ team, seats, securityOn }: { team: TeamDTO; seats: AgentRoleDTO[]; securityOn: boolean }) {
  const save = useSave();
  const usesCodex = seats.some((s) => s.resolved.provider === 'codex' || s.resolved.fallback?.provider === 'codex');
  return (
    <Panel className="mb-6">
      <PanelHeader title="Connected AIs" description="Orbit uses the AI tools you already have, with your own logins. It never sees or stores their credentials." />
      <div className="grid gap-3 px-5 pb-4 md:grid-cols-2">
        {team.providers.map((p) => (
          <ProviderCard key={p.provider} p={p} />
        ))}
        {team.openrouter ? <OpenRouterCard status={team.openrouter} /> : null}
        {team.huggingface ? <HuggingFaceCard status={team.huggingface} /> : null}
      </div>
      <div className="flex items-start justify-between gap-6 border-t border-seam px-5 py-4">
        <div>
          <p className="text-sm font-[600]">Switch AI automatically</p>
          <p className="mt-0.5 max-w-[62ch] text-xs text-dust">
            When an agent's AI is not ready or hits its usage limit, Orbit hands that step to the other AI and notes it in the timeline. Your work keeps moving.
          </p>
        </div>
        <Switch checked={team.fallback} onCheckedChange={(v) => save.mutate({ team: { fallback: v } })} label="Switch AI automatically" />
      </div>
      <div className="flex items-start justify-between gap-6 border-t border-seam px-5 py-4">
        <div>
          <p className="text-sm font-[600]">Security review on every Autopilot task</p>
          <p className="mt-0.5 max-w-[62ch] text-xs text-dust">
            The security reviewer checks each change for leaked secrets, injection, missing auth checks and risky dependencies. Serious problems go back to the engineer before you see the change. You can also run it from the workspace with Check security.
          </p>
        </div>
        <Switch checked={securityOn} onCheckedChange={(v) => save.mutate({ team: { securityReview: v } })} label="Security review on every Autopilot task" />
      </div>
      {team.worktrees.codexBlocked && usesCodex ? (
        <div className="flex flex-wrap items-start gap-3 border-t border-seam bg-signal/[0.05] px-5 py-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-signal-deep" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-[600]">Codex can't run your tests in the current work folder</p>
            <p className="mt-0.5 text-xs text-dust">
              On Windows, Codex's sandbox blocks Node and similar tools inside your user folder, where Orbit keeps its work copies (<span className="mono">{team.worktrees.root}</span>). Moving them fixes it. Your projects stay where they are.
            </p>
          </div>
          {team.worktrees.suggestedRoot ? (
            <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate({ execution: { worktreeRoot: team.worktrees.suggestedRoot } })}>
              Use {team.worktrees.suggestedRoot}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

function SeatCard({ a, team }: { a: AgentRoleDTO; team: TeamDTO }) {
  const save = useSave();
  const [showRuns, setShowRuns] = useState(false);
  const Icon = SEAT_ICON[a.role];
  const claude = team.providers.find((p) => p.provider === 'claude');
  const codex = team.providers.find((p) => p.provider === 'codex');
  const r = a.resolved;
  const options: { value: AgentRoleDTO['provider']; label: string; disabled?: boolean }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'claude', label: 'Claude', disabled: !claude },
    { value: 'codex', label: 'Codex', disabled: !codex },
  ];
  const plan = a.recentRuns.some((x) => x.runtime === 'claude-code-cli');

  return (
    <Panel className="flex flex-col">
      <div className="flex items-start gap-3 px-5 pt-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-seam-2 bg-hull-2" aria-hidden>
          <Icon className={cn('size-4', r.provider ? PROVIDER_TEXT[r.provider] : 'text-dust')} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-6">{a.title}</h2>
          <p className="mt-1 text-xs leading-5 text-dust">{a.description}</p>
        </div>
      </div>

      <div className="mt-4 px-5">
        <div className="inline-flex rounded-[9px] border border-seam bg-night p-0.5" role="radiogroup" aria-label={`AI for the ${a.title}`}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={a.provider === o.value}
              disabled={o.disabled || save.isPending}
              onClick={() => save.mutate({ team: { [a.role]: o.value } })}
              className={cn(
                'rounded-[7px] px-3 py-1 text-xs transition-colors disabled:opacity-40',
                a.provider === o.value ? 'bg-hull-3 text-chalk shadow-[inset_0_0_0_1px_var(--color-seam-2)]' : 'text-dust hover:text-chalk',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div className={cn('mt-3 rounded-[10px] border px-3 py-2.5', r.available ? 'border-seam bg-night/40' : 'border-signal/40 bg-signal/[0.05]')}>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {r.available ? <ProviderBadge provider={r.provider} model={r.model ?? (r.provider === 'codex' ? 'default model' : null)} /> : <span className="text-signal-deep">Not ready</span>}
          </p>
          <p className="mt-1 text-2xs leading-5 text-dust">{r.why}</p>
          {r.fallback ? (
            <p className="mt-1 text-2xs text-dust-2">
              Backup: <span className={PROVIDER_TEXT[r.fallback.provider]}>{PROVIDER_NAME[r.fallback.provider]}</span> takes over on usage limits.
            </p>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {claude ? (
            <label className="inline-flex items-center gap-1.5 text-2xs text-dust">
              <span className="text-claude">Claude</span>
              <select className={selectClass} value={claude.models.some((m) => m.id === a.model) ? a.model : '__custom'} onChange={(e) => e.target.value !== '__custom' && save.mutate({ models: { [a.role]: e.target.value } })} aria-label={`Claude model for the ${a.title}`}>
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
            <label className="inline-flex items-center gap-1.5 text-2xs text-dust">
              <span className="text-codex">Codex</span>
              <select className={selectClass} value={a.codexModel ?? ''} onChange={(e) => save.mutate({ codexModels: { [a.role]: e.target.value || null } })} aria-label={`Codex model for the ${a.title}`}>
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
          <select className={selectClass} value={a.effort} onChange={(e) => save.mutate({ efforts: { [a.role]: e.target.value as EffortLevel } })} aria-label={`Effort for the ${a.title}`} title={EFFORT_INFO[a.effort].description}>
            {EFFORT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {EFFORT_INFO[l].label} effort
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-auto border-t border-seam px-5 py-3 text-2xs text-dust">
        {a.role === 'assistant' ? (
          <span>
            Works with you in the{' '}
            <Link to="/" className="text-chalk underline-offset-2 hover:underline">
              workspace
            </Link>
            .
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="tabular">
              {a.stats.runs} {a.stats.runs === 1 ? 'run' : 'runs'}, {a.stats.succeeded} finished{a.stats.failed ? `, ${a.stats.failed} failed` : ''}
            </span>
            {a.stats.avgDurationMs != null ? <span className="tabular">typically {formatDuration(a.stats.avgDurationMs)}</span> : null}
            {a.stats.totalCostUsd ? <span className="tabular">{plan ? `≈ ${formatUsd(a.stats.totalCostUsd)} of plan usage at API prices` : formatUsd(a.stats.totalCostUsd)}</span> : null}
            {a.recentRuns.length ? (
              <button type="button" className="ml-auto text-dust hover:text-chalk" onClick={() => setShowRuns(!showRuns)} aria-expanded={showRuns}>
                {showRuns ? 'Hide recent runs' : 'Recent runs'}
              </button>
            ) : null}
          </div>
        )}
        {showRuns ? (
          <ul className="mt-2 divide-y divide-seam rounded-[8px] border border-seam">
            {a.recentRuns.map((run) => (
              <li key={run.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <Link to={`/missions/${run.missionId}`} className="min-w-0 flex-1 truncate text-chalk/90 hover:underline">
                  {run.missionTitle}
                </Link>
                <ProviderBadge provider={run.runtime === 'codex-cli' ? 'codex' : run.runtime === 'scripted' ? 'scripted' : 'claude'} quiet />
                <Tag tone={run.status === 'succeeded' ? 'success' : run.status === 'running' ? 'active' : run.status === 'cancelled' ? 'neutral' : 'danger'}>{run.status}</Tag>
                <span className="w-14 text-right text-dust-2">{timeAgo(run.startedAt)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}

export function AgentsPage() {
  const agents = useAgents();
  const team = useTeam();
  const settings = useSettings();
  const securityOn = settings.data?.team.securityReview ?? true;
  if (agents.isPending || team.isPending) return <Loading />;
  if (agents.error || team.error) return <ErrorNote error={agents.error ?? team.error} />;
  return (
    <>
      <PageHeader
        title="Your agents"
        description="Each agent has one job and the AI that suits it. On Auto, the reviewers use a different AI from the one that wrote the code, so every change gets a second opinion."
      />
      <FlowStrip seats={agents.data} security={securityOn} />
      <TeamPanel team={team.data} seats={agents.data} securityOn={securityOn} />
      <div className="grid gap-6 lg:grid-cols-2">
        {agents.data.map((a) => (
          <SeatCard key={a.role} a={a} team={team.data} />
        ))}
      </div>
    </>
  );
}

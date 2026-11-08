import { ExternalLink, Puzzle, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { PluginActionDTO, PluginDTO } from '@orbit/shared';
import { Button, Dialog, ErrorNote, Input, Loading, PageHeader, Panel, PanelHeader, Switch } from '../components/ui';
import { post, useAction, useSkillDetails, useSkills } from '../lib/api';
import { cn } from '../lib/utils';

/*
  Skills: everything Claude Code's marketplaces offer, searchable in one place. Installing
  here is Claude Code's own `/plugin install`, so a skill works in Orbit's sessions and in
  your terminal alike.
*/

const SKILL_KEYS = [['skills'], ['skill-details']];

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Source({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-2xs text-dust hover:text-chalk">
      <span className="truncate">{url.replace(/^https:\/\/(www\.)?/, '')}</span>
      <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

/** What an installed plugin brings: its skills and agents, and anything that runs code. */
function DetailsDialog({ plugin, onClose }: { plugin: PluginDTO | null; onClose: () => void }) {
  const details = useSkillDetails(plugin?.installed ? plugin.id : null);
  const d = details.data;
  return (
    <Dialog open={!!plugin} onOpenChange={(o) => !o && onClose()} title={plugin?.name ?? ''} description={plugin?.description ?? undefined} wide>
      {!plugin ? null : !plugin.installed ? (
        <p className="text-sm text-dust">Claude Code shows exactly what a plugin contains once it is installed.</p>
      ) : details.isPending ? (
        <Loading label="Asking Claude Code" />
      ) : details.error ? (
        <ErrorNote error={details.error} />
      ) : d ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div className="rounded-[10px] bg-hull-2 px-3 py-2">
              <dt className="text-2xs text-dust">Skills</dt>
              <dd className="font-[650] tabular">{d.skills.length}</dd>
            </div>
            <div className="rounded-[10px] bg-hull-2 px-3 py-2">
              <dt className="text-2xs text-dust">Agents</dt>
              <dd className="font-[650] tabular">{d.agents}</dd>
            </div>
            <div className={cn('rounded-[10px] px-3 py-2', d.hooks ? 'bg-signal/[0.12]' : 'bg-hull-2')}>
              <dt className="text-2xs text-dust">Hooks</dt>
              <dd className="font-[650] tabular">{d.hooks}</dd>
            </div>
            <div className={cn('rounded-[10px] px-3 py-2', d.mcpServers ? 'bg-signal/[0.12]' : 'bg-hull-2')}>
              <dt className="text-2xs text-dust">MCP servers</dt>
              <dd className="font-[650] tabular">{d.mcpServers}</dd>
            </div>
          </dl>
          {d.hooks || d.mcpServers ? (
            <p className="flex gap-2 rounded-[10px] bg-signal/[0.1] px-3 py-2 text-xs text-signal-deep">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {d.hooks ? 'Hooks run commands on their own when your agents work. ' : ''}
              {d.mcpServers ? 'MCP servers are programs that run on this computer. ' : ''}
              Keep this plugin only if you trust where it comes from.
            </p>
          ) : null}
          {d.alwaysOn ? <p className="text-xs text-dust">Adds about {d.alwaysOn} to every session, plus more each time one of its skills is used.</p> : null}
          <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap rounded-[10px] bg-hull-2 p-3 text-[12px] leading-5 text-chalk/85">{d.text}</pre>
        </div>
      ) : null}
    </Dialog>
  );
}

function InstallDialog({ plugin, onClose, onDone }: { plugin: PluginDTO | null; onClose: () => void; onDone: (p: PluginDTO) => void }) {
  const install = useAction((id: string) => post<PluginActionDTO>('/api/skills/install', { id }), { success: (r) => r.message, invalidate: SKILL_KEYS });
  return (
    <Dialog
      open={!!plugin}
      onOpenChange={(o) => !o && !install.isPending && onClose()}
      title={plugin ? `Install ${plugin.name}?` : ''}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={install.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={install.isPending} onClick={() => plugin && install.mutate(plugin.id, { onSuccess: () => onDone(plugin) })}>
            Install
          </Button>
        </>
      }
    >
      {plugin ? (
        <div className="space-y-3 text-sm">
          {plugin.description ? <p className="text-chalk/90">{plugin.description}</p> : null}
          <p className="text-xs text-dust">
            From {plugin.marketplaceLabel}
            {plugin.installs ? ` · ${compact(plugin.installs)} installs` : ''}
            {plugin.version ? ` · version ${plugin.version}` : ''}
          </p>
          <Source url={plugin.sourceUrl} />
          <p className="rounded-[10px] bg-hull-2 px-3 py-2 text-xs text-dust">
            It installs for Claude Code on this computer, so it also works in your terminal. Plugins can bring hooks and MCP servers that run on this computer: install only what you
            trust. Your Claude sessions can use it from their next message.
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}

function PluginRow({ p, onInstall, onDetails }: { p: PluginDTO; onInstall: (p: PluginDTO) => void; onDetails: (p: PluginDTO) => void }) {
  const toggle = useAction((on: boolean) => post<PluginActionDTO>('/api/skills/enabled', { id: p.id, enabled: on }), { success: (r) => r.message, invalidate: SKILL_KEYS });
  const remove = useAction(() => post<PluginActionDTO>('/api/skills/uninstall', { id: p.id }), { success: (r) => r.message, invalidate: SKILL_KEYS });
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <button type="button" onClick={() => onDetails(p)} className="text-left text-sm font-[650] text-chalk hover:underline">
            {p.name}
          </button>
          <span className="text-2xs text-dust">
            {p.marketplaceLabel}
            {p.installs ? ` · ${compact(p.installs)} installs` : ''}
          </span>
        </p>
        {p.description ? <p className="mt-0.5 line-clamp-2 text-xs text-dust">{p.description}</p> : null}
        <div className="mt-1">
          <Source url={p.sourceUrl} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {p.installed ? (
          confirm ? (
            <>
              <span className="text-xs">Remove {p.name}?</span>
              <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate(undefined)}>
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <>
              <Switch checked={p.enabled !== false} onCheckedChange={(on) => toggle.mutate(on)} label={`${p.name} on or off`} disabled={toggle.isPending} />
              <Button size="sm" variant="ghost" onClick={() => onDetails(p)}>
                What&apos;s inside
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
                Remove
              </Button>
            </>
          )
        ) : p.needsCommand ? (
          <span className="max-w-[220px] text-right text-2xs text-dust">Installs by running a command: add it in Claude Code with /plugin, where you can review it.</span>
        ) : (
          <Button size="sm" onClick={() => onInstall(p)}>
            Install
          </Button>
        )}
      </div>
    </li>
  );
}

export function SkillsPage() {
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(40);
  const [installing, setInstalling] = useState<PluginDTO | null>(null);
  const [details, setDetails] = useState<PluginDTO | null>(null);
  const [source, setSource] = useState('');
  const q = useDebounced(query.trim());
  const skills = useSkills(q, filter, limit);
  const refresh = useAction(() => post<PluginActionDTO>('/api/skills/refresh'), { success: (r) => r.message, invalidate: SKILL_KEYS });
  const addMarket = useAction((s: string) => post<PluginActionDTO>('/api/skills/marketplaces', { source: s }), { success: (r) => r.message, invalidate: SKILL_KEYS });
  const [showOwn, setShowOwn] = useState(false);

  useEffect(() => setLimit(40), [q, filter]);

  const d = skills.data;
  const totalAll = d?.marketplaces.reduce((s, m) => s + m.count, 0) ?? 0;
  const chips = [
    { id: 'all', label: 'All', count: totalAll },
    { id: 'installed', label: 'Installed', count: d?.installed.length ?? 0 },
    ...(d?.marketplaces ?? []).map((m) => ({ id: m.name, label: m.label, count: m.count })),
  ];

  return (
    <>
      <PageHeader
        title="Skills"
        description="Skills teach your agents new abilities: a design system, a framework, a way of working. These are Claude Code's own plugins, so anything you install here also works in your terminal."
        action={
          <Button onClick={() => refresh.mutate(undefined)} loading={refresh.isPending} title="Get the newest catalogs from every marketplace">
            <RefreshCw className="size-4" /> Refresh catalogs
          </Button>
        }
      />

      <label className="flex h-12 items-center gap-3 rounded-[14px] border border-seam-2 bg-hull px-4 text-dust focus-within:border-telemetry/70 focus-within:shadow-[0_0_0_3px_rgb(11_124_113/0.12)]">
        <Search className="size-4 shrink-0" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={totalAll ? `Search ${totalAll.toLocaleString()} plugins: design, testing, supabase, stripe…` : 'Search plugins'}
          aria-label="Search plugins"
          autoFocus
          className="min-w-0 flex-1 bg-transparent text-[15px] text-chalk outline-none placeholder:text-dust-2"
        />
        {skills.isFetching ? <RefreshCw className="size-4 shrink-0 animate-spin" aria-label="Searching" /> : null}
      </label>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Show">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setFilter(c.id)}
            aria-pressed={filter === c.id}
            className={cn('h-8 rounded-full border px-3 text-xs transition-colors', filter === c.id ? 'border-chalk bg-chalk text-hull' : 'border-seam bg-hull text-chalk/80 hover:border-seam-2')}
          >
            {c.label} <span className="tabular opacity-70">{c.count.toLocaleString()}</span>
          </button>
        ))}
      </div>

      {skills.isPending ? (
        <div className="mt-8">
          <Loading label="Reading Claude Code's marketplaces" />
        </div>
      ) : skills.error ? (
        <div className="mt-6">
          <ErrorNote error={skills.error} />
        </div>
      ) : d && !d.available ? (
        <Panel className="mt-6 p-5">
          <p className="text-sm font-[650]">Claude Code&apos;s plugins are not available right now</p>
          <p className="mt-1 text-sm text-dust">{d.reason}</p>
        </Panel>
      ) : d ? (
        <div className="mt-6 space-y-6">
          {filter !== 'installed' && !q && d.installed.length ? (
            <Panel>
              <PanelHeader title={`Installed (${d.installed.length})`} description="Turned-on plugins load in every Claude session, in Orbit and in your terminal." />
              <ul className="divide-y divide-seam">
                {d.installed.map((p) => (
                  <PluginRow key={p.id} p={p} onInstall={setInstalling} onDetails={setDetails} />
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader
              title={filter === 'installed' ? 'Installed plugins' : q ? `${d.total.toLocaleString()} ${d.total === 1 ? 'match' : 'matches'}` : 'Most installed'}
              description={q ? 'Best matches first, then the most installed.' : filter === 'installed' ? undefined : 'Popular plugins first. Search to find anything else.'}
            />
            {d.results.length ? (
              <ul className="divide-y divide-seam">
                {d.results.map((p) => (
                  <PluginRow key={p.id} p={p} onInstall={setInstalling} onDetails={setDetails} />
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-sm text-dust">{q ? `Nothing matches "${q}". Try a shorter word, or refresh the catalogs.` : 'Nothing here yet.'}</p>
            )}
            {d.total > d.results.length ? (
              <div className="border-t border-seam px-5 py-3">
                <Button size="sm" variant="ghost" onClick={() => setLimit(Math.min(limit + 60, 200))} disabled={limit >= 200}>
                  Show more ({d.results.length} of {d.total.toLocaleString()})
                </Button>
              </div>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader
              title={`Your own skills (${d.skills.length})`}
              description="Skill folders in Claude Code's skills folder. They load in every Claude session too."
              action={
                d.skills.length ? (
                  <Button size="sm" variant="ghost" onClick={() => setShowOwn(!showOwn)} aria-expanded={showOwn}>
                    {showOwn ? 'Hide' : 'Show all'}
                  </Button>
                ) : undefined
              }
            />
            {showOwn ? (
              <ul className="divide-y divide-seam">
                {d.skills.map((s) => (
                  <li key={s.path} className="px-5 py-2.5">
                    <p className="text-sm font-[600]">{s.name}</p>
                    {s.description ? <p className="line-clamp-2 text-xs text-dust">{s.description}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-3 text-xs text-dust">{d.skills.map((s) => s.name).slice(0, 12).join(', ') || 'None yet.'}{d.skills.length > 12 ? ` and ${d.skills.length - 12} more` : ''}</p>
            )}
          </Panel>

          <Panel className="p-5">
            <div className="flex items-start gap-3">
              <Puzzle className="mt-0.5 size-5 shrink-0 text-dust" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-[650]">Add a marketplace</p>
                <p className="mt-0.5 text-xs text-dust">
                  A GitHub repository or URL that publishes Claude Code plugins, like <span className="mono">anthropics/skills</span>. Only add marketplaces you trust: their plugins can
                  run commands on this computer.
                </p>
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (source.trim()) addMarket.mutate(source.trim(), { onSuccess: () => setSource('') });
                  }}
                >
                  <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="owner/repo or https://…" aria-label="Marketplace" className="max-w-sm" />
                  <Button type="submit" loading={addMarket.isPending} disabled={!source.trim()}>
                    Add
                  </Button>
                </form>
              </div>
            </div>
          </Panel>
          <p className="text-2xs text-dust-2">Codex sessions do not use Claude Code plugins.</p>
        </div>
      ) : null}

      <InstallDialog plugin={installing} onClose={() => setInstalling(null)} onDone={(p) => (setInstalling(null), setDetails({ ...p, installed: true, enabled: true }))} />
      <DetailsDialog plugin={details} onClose={() => setDetails(null)} />
    </>
  );
}

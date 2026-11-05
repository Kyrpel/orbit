import { Check, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { IntegrationDTO } from '@orbit/shared';
import { Button, Code, Empty, ErrorNote, Field, Input, Loading, PageHeader, Panel, PanelHeader, Tag } from '../components/ui';
import { del, keys, post, useAction, useDoctor, useIntegrations } from '../lib/api';

export function AsanaConnectForm({ onConnected }: { onConnected?: (i: IntegrationDTO) => void }) {
  const [token, setToken] = useState('');
  const connect = useAction((t: string) => post<IntegrationDTO>('/api/integrations/asana', { token: t }), {
    success: (i) => `Connected Asana as ${i.account.name ?? i.account.id}`,
    invalidate: [keys.integrations, keys.doctor, keys.overview],
  });
  return (
    <div className="space-y-3">
      <Field
        label="Personal access token"
        htmlFor="asana-token"
        hint={
          <>
            Create one in the Asana developer console (<Code>app.asana.com/0/my-apps</Code>), then Create new token. Orbit verifies it with <Code>GET /users/me</Code> and stores it in
            your Orbit data folder, never in the database or logs.
          </>
        }
      >
        <Input id="asana-token" type="password" autoComplete="off" className="mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="2/1200…" />
      </Field>
      <Button variant="primary" loading={connect.isPending} disabled={token.trim().length < 16} onClick={() => connect.mutate(token.trim(), { onSuccess: (i) => { setToken(''); onConnected?.(i); } })}>
        Connect Asana
      </Button>
    </div>
  );
}

function AsanaAccount({ i }: { i: IntegrationDTO }) {
  const [gid, setGid] = useState('');
  const add = useAction((externalUserId: string) => post(`/api/integrations/${i.id}/authorized-users`, { externalUserId }), { success: 'User authorized', invalidate: [keys.integrations] });
  const removeUser = useAction((u: string) => del(`/api/integrations/${i.id}/authorized-users/${u}`), { invalidate: [keys.integrations] });
  const disconnect = useAction(() => del(`/api/integrations/${i.id}`), { success: 'Asana disconnected. Revoke the token in Asana if you no longer need it.', invalidate: [keys.integrations, keys.projects] });
  return (
    <div className="divide-y divide-seam">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div>
          <p className="text-sm font-[600]">{i.account.name ?? i.account.id}</p>
          <p className="text-2xs text-dust">{i.account.email ?? 'no email'}, personal access token</p>
          {i.statusMessage ? <p className="mt-1 text-xs text-fault">{i.statusMessage}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <Tag tone={i.status === 'connected' ? 'success' : 'danger'}>{i.status}</Tag>
          <Button size="sm" variant="danger" loading={disconnect.isPending} onClick={() => disconnect.mutate(undefined)}>
            Disconnect
          </Button>
        </div>
      </div>
      <div className="space-y-3 px-5 py-4">
        <div>
          <p className="text-sm font-[600]">Who can trigger missions with /orbit run</p>
          <p className="text-xs text-dust">Comments from anyone else are ignored and logged in Activity. If an author cannot be identified, the mission waits for your approval.</p>
        </div>
        <ul className="divide-y divide-seam rounded-[10px] border border-seam">
          {i.authorizedUsers.map((u) => (
            <li key={u.externalUserId} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="flex-1">
                {u.displayName ?? u.externalUserId} <span className="mono text-2xs text-dust">{u.externalUserId}</span>
                {u.externalUserId === i.account.id ? <span className="text-2xs text-dust"> (token owner)</span> : null}
              </span>
              {u.externalUserId !== i.account.id ? (
                <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => removeUser.mutate(u.externalUserId)}>
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Input className="mono" value={gid} onChange={(e) => setGid(e.target.value)} placeholder="Asana user gid, e.g. 1203456789012345" aria-label="Asana user gid" />
          <Button disabled={!/^\d{3,}$/.test(gid.trim())} loading={add.isPending} onClick={() => add.mutate(gid.trim(), { onSuccess: () => setGid('') })}>
            Authorize
          </Button>
        </div>
      </div>
    </div>
  );
}

export function IntegrationsPage() {
  const integrations = useIntegrations();
  const doctor = useDoctor();
  const gh = doctor.data?.checks.find((c) => c.id === 'gh');
  const asana = integrations.data?.filter((i) => i.provider === 'asana') ?? [];
  return (
    <>
      <PageHeader title="Integrations" description="Where tasks come from and where pull requests go. Credentials stay on this machine." />
      <div className="space-y-6">
        <Panel>
          <PanelHeader title="GitHub" description="Orbit uses your GitHub CLI login to push branches and open pull requests, only after you approve each one." />
          <div className="px-5 py-4 text-sm">
            {!gh ? (
              <Loading />
            ) : (
              <div className="flex items-start gap-3">
                {gh.status === 'ok' ? <Check className="mt-0.5 size-4 text-go" /> : <X className="mt-0.5 size-4 text-signal-deep" />}
                <div>
                  <p>{gh.detail}</p>
                  {gh.fix ? <p className="mt-1 text-xs text-dust">{gh.fix}</p> : null}
                </div>
              </div>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Asana" description="Read tasks, listen for /orbit run comments, post progress and pull request links back to the task." />
          {integrations.isPending ? <Loading /> : integrations.error ? <div className="p-5"><ErrorNote error={integrations.error} /></div> : asana.length ? asana.map((i) => <AsanaAccount key={i.id} i={i} />) : (
            <div className="px-5 py-4">
              <AsanaConnectForm />
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="AI runtime" description="Agents run through the Claude Agent SDK (API key or cloud provider), or your locally installed Claude Code." />
          {doctor.isPending ? (
            <Loading />
          ) : (
            <ul className="divide-y divide-seam">
              {doctor.data?.runtimes.map((r) => (
                <li key={r.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                  {r.available ? <Check className="mt-0.5 size-4 text-go" /> : <X className="mt-0.5 size-4 text-dust" />}
                  <div>
                    <p>{r.displayName}</p>
                    <p className="text-xs text-dust">{r.available ? Object.entries(r.details).map(([k, v]) => `${k}: ${v}`).join(', ') : r.reason}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Planned" />
          <Empty title="GitHub Issues, Linear and Jira">Orbit's core works with a provider-neutral task model, so these plug in as connectors. Contributions are welcome.</Empty>
        </Panel>
      </div>
    </>
  );
}

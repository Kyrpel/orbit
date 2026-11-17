import { Check, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { IntegrationDTO } from '@orbit/shared';
import { Button, Code, Disclosure, ErrorNote, Field, Input, Loading, PageHeader, Panel, PanelHeader, Tag } from '../components/ui';
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
            In Asana, open <Code>app.asana.com/0/my-apps</Code> and choose Create new token, then paste it here. Orbit checks it with Asana and keeps it on this computer only.
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
  const add = useAction((externalUserId: string) => post(`/api/integrations/${i.id}/authorized-users`, { externalUserId }), { success: 'Added', invalidate: [keys.integrations] });
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
          <p className="text-sm font-[600]">Who may start tasks with /orbit run</p>
          <p className="text-xs text-dust">Comments from anyone else are ignored and noted in Activity. If Orbit cannot tell who wrote a comment, the task waits for your OK.</p>
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
          <Input className="mono" value={gid} onChange={(e) => setGid(e.target.value)} placeholder="Asana user ID, e.g. 1203456789012345" aria-label="Asana user ID" />
          <Button disabled={!/^\d{3,}$/.test(gid.trim())} loading={add.isPending} onClick={() => add.mutate(gid.trim(), { onSuccess: () => setGid('') })}>
            Add person
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
      <PageHeader title="Connections" description="Where tasks come from and where finished work goes. Your logins stay on this computer." />
      <div className="space-y-6">
        <Panel>
          <PanelHeader title="GitHub" description="Used to open pull requests with your own GitHub login, and only after you approve each one." />
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
          <PanelHeader title="Asana" description="Optional. Autopilot can pick up your Asana tasks and post its progress back on them." />
          {integrations.isPending ? <Loading /> : integrations.error ? <div className="p-5"><ErrorNote error={integrations.error} /></div> : asana.length ? asana.map((i) => <AsanaAccount key={i.id} i={i} />) : (
            <div className="px-5 py-4">
              <AsanaConnectForm />
            </div>
          )}
        </Panel>

        <Panel>
          <Disclosure title="AI tools found on this computer" summary="A check of what Orbit can use, for when something does not work.">
            {doctor.isPending ? (
              <Loading />
            ) : (
              <ul className="divide-y divide-seam border-t border-seam">
                {doctor.data?.runtimes.map((r) => (
                  <li key={r.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                    {r.available ? <Check className="mt-0.5 size-4 text-go" aria-label="Ready" /> : <X className="mt-0.5 size-4 text-dust" aria-label="Not available" />}
                    <div>
                      <p>{r.displayName}</p>
                      <p className="text-xs text-dust">{r.available ? Object.entries(r.details).map(([k, v]) => `${k}: ${v}`).join(', ') : r.reason}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Disclosure>
        </Panel>
      </div>
    </>
  );
}

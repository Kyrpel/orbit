import { useQuery } from '@tanstack/react-query';
import { Check, Cpu, KeyRound, MessageSquareText, Moon, Pause, Play, Plus, Trash2, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { parseHfRepository, type HfEndpointDTO, type HfHardwareDTO, type HfModelPlanDTO, type HuggingFaceStatusDTO } from '@orbit/shared';
import { api, del, keys, post, useAction } from '../lib/api';
import { cn } from '../lib/utils';
import { InstructionsEditor } from './openrouter-card';
import { Button, Input, Tag } from './ui';

/*
  Hugging Face on the Agents page: your own models on rented GPUs (Inference Endpoints).

  Paste a model link and Orbit shows its files and the GPUs each one fits on, with prices, right
  away (no token needed for that). With a token it creates the endpoint, which sleeps after some
  minutes without use so it stops costing; sessions wake it when they need it.
*/

const HF_KEY = ['huggingface'] as const;
/** States where the endpoint is on its way somewhere: the card checks again every few seconds. */
const MOVING = new Set(['pending', 'initializing', 'updating']);

const STATE: Record<string, { label: string; tone: 'success' | 'neutral' | 'active' | 'attention' | 'danger' }> = {
  running: { label: 'Awake', tone: 'success' },
  scaledToZero: { label: 'Asleep, no cost', tone: 'neutral' },
  paused: { label: 'Paused, no cost', tone: 'neutral' },
  pending: { label: 'Starting', tone: 'active' },
  initializing: { label: 'Starting', tone: 'active' },
  updating: { label: 'Updating', tone: 'active' },
  failed: { label: 'Failed', tone: 'danger' },
  updateFailed: { label: 'Update failed', tone: 'danger' },
};

const dollars = (n: number) => `$${n.toFixed(2)}`;

function useHuggingFace(initial: HuggingFaceStatusDTO) {
  return useQuery({
    queryKey: HF_KEY,
    queryFn: () => api<HuggingFaceStatusDTO>('/api/huggingface'),
    initialData: initial,
    staleTime: 5_000,
    refetchInterval: (q) => (q.state.data?.endpoints.some((e) => MOVING.has(e.state)) ? 8_000 : 60_000),
  });
}

function EndpointRow({ e }: { e: HfEndpointDTO }) {
  const invalidate = [HF_KEY, keys.team];
  const pause = useAction(() => post(`/api/huggingface/endpoints/${e.name}/pause`), { success: `${e.name} paused: no cost until you resume it`, invalidate });
  const resume = useAction(() => post(`/api/huggingface/endpoints/${e.name}/resume`), { success: `${e.name} is starting`, invalidate });
  const remove = useAction(() => del(`/api/huggingface/endpoints/${e.name}`), { success: `${e.name} deleted`, invalidate });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const st = STATE[e.state] ?? { label: e.state, tone: 'neutral' as const };
  const quant = e.file?.match(/(I?Q\d+_[A-Z0-9]+(?:_[A-Z])?|BF16|F16)/i)?.[1];
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="mono font-[600]">{e.name}</span>
        <Tag tone={st.tone}>
          {e.state === 'scaledToZero' ? <Moon className="size-3" aria-hidden /> : null}
          {st.label}
        </Tag>
        {!e.usable ? <Tag tone="attention">Not a llama.cpp model: sessions cannot use it</Tag> : null}
        <span className="ml-auto flex items-center gap-1">
          {e.state === 'paused' ? (
            <Button size="sm" onClick={() => resume.mutate(undefined)} loading={resume.isPending}>
              <Play className="size-3.5" aria-hidden /> Resume
            </Button>
          ) : e.state !== 'failed' ? (
            <Button size="sm" onClick={() => pause.mutate(undefined)} loading={pause.isPending} title="Stops it completely (no cost) until you resume it">
              <Pause className="size-3.5" aria-hidden /> Pause
            </Button>
          ) : null}
          {confirmDelete ? (
            <>
              <Button size="sm" variant="danger" onClick={() => remove.mutate(undefined)} loading={remove.isPending}>
                Delete it
              </Button>
              <Button size="sm" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="grid size-7 place-items-center rounded-[7px] text-dust hover:bg-hull-2 hover:text-fault" aria-label={`Delete ${e.name}`} title="Delete this endpoint on Hugging Face">
              <Trash2 className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      <p className="mt-0.5 text-2xs text-dust">
        <span className="mono">{e.repository}</span>
        {quant ? ` · ${quant}` : ''} · {e.hardware.label}
        {e.hardware.pricePerHour != null ? ` · ${dollars(e.hardware.pricePerHour)}/hour while awake` : ''}
        {e.sleepAfterMinutes != null ? ` · sleeps after ${e.sleepAfterMinutes} min without use` : ' · never sleeps'}
      </p>
      {e.state === 'failed' || e.state === 'updateFailed' ? <p className="mt-1 max-w-[78ch] text-2xs text-fault">{e.message ?? 'It failed to start.'} Open it on endpoints.huggingface.co to see its logs.</p> : null}
      {MOVING.has(e.state) && e.message ? <p className="mt-1 text-2xs text-dust">{e.message}</p> : null}
      {e.usable ? <InstructionsEditor id={`hf-${e.name}`} label={e.name} value={e.instructions} save={(t) => post(`/api/huggingface/endpoints/${e.name}/instructions`, { instructions: t })} /> : null}
    </li>
  );
}

/** How a GPU suits a file: fits, fits but with little room, or too small. */
function fitOf(h: HfHardwareDTO, needs: number): 'fits' | 'tight' | 'small' {
  if (h.gpuMemoryGb < needs) return 'small';
  return h.gpuMemoryGb < needs * 1.12 ? 'tight' : 'fits';
}

function NewEndpoint({ status }: { status: HuggingFaceStatusDTO }) {
  const [link, setLink] = useState('');
  const repository = parseHfRepository(link);
  const [debounced, setDebounced] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(repository), 400);
    return () => clearTimeout(t);
  }, [repository]);
  // Pasting a link is enough: the files, GPUs and prices load on their own.
  const plan = useQuery({
    queryKey: ['hf-plan', debounced],
    queryFn: () => post<HfModelPlanDTO>('/api/huggingface/plan', { model: debounced }),
    enabled: !!debounced,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const p = plan.data && plan.data.repository === debounced ? plan.data : null;
  const [file, setFile] = useState<string | null>(null);
  const [hardwareId, setHardwareId] = useState<string | null>(null);
  const [sleep, setSleep] = useState(15);
  const [name, setName] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!p) return;
    setFile(p.suggested?.file ?? p.files[0]?.path ?? null);
    setHardwareId(p.suggested?.hardwareId ?? null);
    setName(p.name);
    setConfirm(false);
  }, [p]);
  const chosen = p?.files.find((f) => f.path === file) ?? null;
  const gpus = useMemo(() => {
    if (!p || !chosen) return [];
    return p.hardware.filter((h) => h.available).map((h) => ({ h, fit: fitOf(h, chosen.needsGb) }));
  }, [p, chosen]);
  const fitting = gpus.filter((g) => g.fit !== 'small');
  const shown = showAll ? gpus : fitting.slice(0, 6);
  const hw = p?.hardware.find((h) => h.id === hardwareId) ?? null;
  const hwFit = hw && chosen ? fitOf(hw, chosen.needsGb) : null;
  // A new file may not fit the GPU picked for the previous one: pick the cheapest that fits.
  useEffect(() => {
    if (!chosen || !p) return;
    if (!hw || fitOf(hw, chosen.needsGb) === 'small') setHardwareId(fitting[0]?.h.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);
  const create = useAction(
    () => post<HuggingFaceStatusDTO>('/api/huggingface/endpoints', { repository: p!.repository, file: file!, hardwareId: hardwareId!, name: name.trim() || undefined, sleepAfterMinutes: sleep }),
    { success: 'Endpoint created: Hugging Face is starting it (a few minutes)', invalidate: [HF_KEY, keys.team] },
  );
  const canCreate = status.connected && status.canManage && !!p && !!chosen && !!hw && hwFit !== 'small';

  return (
    <div className="mt-3 border-t border-seam pt-2.5">
      <p className="text-2xs font-[600] uppercase tracking-[0.04em] text-dust">New endpoint</p>
      <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste a model link: https://huggingface.co/owner/model-GGUF" aria-label="Hugging Face model link" className="mt-1.5 h-8 max-w-[560px] text-xs" />
      {link.trim() && !repository ? <p className="mt-1 text-2xs text-fault">That is not a Hugging Face model link.</p> : null}
      {plan.isFetching && !p ? <p className="mt-2 text-2xs text-dust">Reading the model and Hugging Face's GPU prices…</p> : null}
      {plan.error && !plan.isFetching ? <p className="mt-2 max-w-[78ch] text-2xs text-fault">{(plan.error as Error).message}</p> : null}
      {p ? (
        <div className="mt-2.5 space-y-3">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="mono font-[600]">{p.repository}</span>
            {p.tools ? (
              <Tag tone="success">
                <Wrench className="size-3" aria-hidden /> Can work in your project
              </Tag>
            ) : (
              <Tag tone="attention">
                <MessageSquareText className="size-3" aria-hidden /> Chat only: no tool support
              </Tag>
            )}
            {p.license ? <span className="text-2xs text-dust">licence {p.license}</span> : null}
            {p.gated ? <Tag tone="attention">Accept its terms on the model page first</Tag> : null}
          </p>

          <label className="block text-2xs text-dust">
            File (smaller loses a little quality, bigger needs a bigger GPU)
            <select value={file ?? ''} onChange={(e) => setFile(e.target.value)} className="mt-1 block h-8 w-full max-w-[560px] rounded-[8px] border border-seam bg-hull px-2 text-xs text-chalk">
              {p.files.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.quant} · {f.sizeGb} GB file · needs about {f.needsGb} GB of GPU memory{f.path === p.suggested?.file ? ' · suggested' : ''}
                  {/MTP/i.test(f.path) ? ' · MTP variant' : ''}
                </option>
              ))}
            </select>
          </label>

          <div>
            <p className="text-2xs text-dust">GPU (price per hour while awake; it costs nothing while asleep)</p>
            <ul className="mt-1 max-w-[640px] divide-y divide-seam rounded-[8px] border border-seam" role="radiogroup" aria-label="GPU">
              {shown.map(({ h, fit }) => (
                <li key={h.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={h.id === hardwareId}
                    disabled={fit === 'small'}
                    onClick={() => setHardwareId(h.id)}
                    className={cn('flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-xs disabled:opacity-45', h.id === hardwareId ? 'bg-hull-2' : 'hover:bg-hull-2/60')}
                  >
                    <span className={cn('grid size-3.5 shrink-0 place-items-center rounded-full border', h.id === hardwareId ? 'border-telemetry' : 'border-seam-2')}>
                      {h.id === hardwareId ? <span className="size-1.5 rounded-full bg-telemetry" /> : null}
                    </span>
                    <Cpu className="size-3.5 shrink-0 text-dust" aria-hidden />
                    <span className="font-[600]">{h.label}</span>
                    <span className="text-dust">
                      {h.gpuMemoryGb} GB · {h.regionLabel} ({h.vendor.toUpperCase()})
                    </span>
                    <span className={cn('ml-auto text-2xs', fit === 'fits' ? 'text-go' : fit === 'tight' ? 'text-signal-deep' : 'text-dust')}>{fit === 'fits' ? 'fits' : fit === 'tight' ? 'fits, little room' : 'too small'}</span>
                    <span className="w-[70px] text-right font-[600] tabular-nums">{dollars(h.pricePerHour)}/h</span>
                  </button>
                </li>
              ))}
              {!fitting.length ? <li className="px-2.5 py-2 text-2xs text-fault">No GPU Hugging Face rents now is big enough for this file. Pick a smaller file.</li> : null}
            </ul>
            <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-1 text-2xs text-telemetry hover:underline">
              {showAll ? 'Show only the cheapest that fit' : `Show all ${gpus.length} GPUs`}
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-2xs text-dust">
              Sleeps after
              <select value={sleep} onChange={(e) => setSleep(Number(e.target.value))} className="mt-1 block h-8 rounded-[8px] border border-seam bg-hull px-2 text-xs text-chalk">
                {[5, 15, 30, 60, 120].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes without use
                  </option>
                ))}
              </select>
            </label>
            <label className="text-2xs text-dust">
              Name
              <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} maxLength={32} className="mono mt-1 h-8 w-[280px] text-xs" aria-label="Endpoint name" />
            </label>
          </div>

          {hw ? (
            <p className="max-w-[78ch] rounded-[8px] bg-hull-2 px-3 py-2 text-xs">
              <span className="font-[600]">{dollars(hw.pricePerHour)} per hour</span> while it is awake, billed by Hugging Face to your account ({dollars(hw.pricePerHour * 8)} for 8 hours of work). It goes to sleep after {sleep} minutes
              without use and costs nothing while asleep; the next message wakes it, which takes a few minutes. Only your token can use it.
            </p>
          ) : null}

          {!status.connected ? (
            <p className="text-2xs text-dust">Connect your Hugging Face token above to create it.</p>
          ) : !status.canManage ? (
            <p className="text-2xs text-fault">Your token can only read. Use a token with write access (or one allowed to manage Inference Endpoints) to create endpoints.</p>
          ) : confirm ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs">Rent the {hw?.label} at {hw ? dollars(hw.pricePerHour) : ''}/hour on your Hugging Face account?</span>
              <Button size="sm" variant="primary" onClick={() => create.mutate(undefined, { onSuccess: () => (setConfirm(false), setLink('')) })} loading={create.isPending}>
                Yes, create it
              </Button>
              <Button size="sm" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="primary" disabled={!canCreate} onClick={() => setConfirm(true)}>
              <Plus className="size-3.5" aria-hidden /> Create endpoint{hw ? ` · ${dollars(hw.pricePerHour)}/hour while awake` : ''}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function HuggingFaceCard({ status: initial }: { status: HuggingFaceStatusDTO }) {
  const { data: status } = useHuggingFace(initial);
  const [token, setToken] = useState('');
  const invalidate = [HF_KEY, keys.team];
  const connect = useAction((t: string) => post<HuggingFaceStatusDTO>('/api/huggingface/token', { token: t }), { success: 'Hugging Face connected', invalidate });
  const disconnect = useAction(() => del<HuggingFaceStatusDTO>('/api/huggingface/token'), { success: 'Hugging Face disconnected', invalidate });

  return (
    <div className="rounded-[10px] border border-seam px-4 py-3 md:col-span-2">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-huggingface" aria-hidden />
        <span className="font-[620]">Hugging Face</span>
        <span className="text-2xs text-dust">your own models on rented GPUs</span>
        {status.connected ? (
          <Tag tone="success" className="ml-auto">
            <Check className="size-3" aria-hidden /> {status.account ? `Connected as ${status.account}` : 'Connected'}
          </Tag>
        ) : (
          <Tag tone="neutral" className="ml-auto">
            Not connected
          </Tag>
        )}
      </div>
      <p className="mt-1.5 max-w-[78ch] text-2xs text-dust">
        Run a model from Hugging Face (a GGUF file) on a GPU you rent by the hour, then choose Hugging Face as the AI in a session. It runs inside Claude Code's tools with your Hugging Face token, never your Claude login, and Hugging Face bills you only while it is awake.
      </p>

      {status.connected ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-dust">
          <span className="inline-flex items-center gap-1">
            <KeyRound className="size-3" aria-hidden /> {status.canManage ? 'Token can create and manage endpoints' : 'Read-only token: it can use endpoints but not create them'}
          </span>
          <button type="button" onClick={() => disconnect.mutate(undefined)} className="font-[600] text-chalk/80 underline-offset-2 hover:underline">
            Disconnect
          </button>
        </p>
      ) : (
        <form
          className="mt-2.5 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) connect.mutate(token.trim(), { onSuccess: () => setToken('') });
          }}
        >
          <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="hf_…" aria-label="Hugging Face token" className="mono h-8 max-w-[340px] text-xs" />
          <Button size="sm" variant="primary" type="submit" loading={connect.isPending} disabled={!token.trim()}>
            Connect
          </Button>
          <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer" className="text-2xs text-telemetry hover:underline">
            Get a token (write access)
          </a>
          <span className="w-full text-2xs text-dust">Orbit checks it with Hugging Face and keeps it in its secrets file on this computer. It is only ever sent to Hugging Face.</span>
        </form>
      )}

      {status.error ? <p className="mt-2 text-2xs text-fault">{status.error}</p> : null}

      {status.connected ? (
        <div className="mt-3 border-t border-seam pt-2">
          <p className="text-2xs font-[600] uppercase tracking-[0.04em] text-dust">Your endpoints</p>
          {status.endpoints.length ? (
            <ul className="divide-y divide-seam">
              {status.endpoints.map((e) => (
                <EndpointRow key={e.name} e={e} />
              ))}
            </ul>
          ) : (
            <p className="py-2 text-xs text-dust">None yet. Paste a model link below to rent a GPU for it.</p>
          )}
        </div>
      ) : null}

      <NewEndpoint status={status} />
    </div>
  );
}

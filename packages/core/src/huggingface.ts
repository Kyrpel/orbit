import type { AgentGateway } from '@orbit/agents';
import {
  HF_PREFIX,
  isHfModel,
  MAX_MODEL_INSTRUCTIONS,
  OrbitError,
  parseHfRepository,
  registerSecret,
  unregisterSecret,
  type HfEndpointDTO,
  type HfEndpointState,
  type HfHardwareDTO,
  type HfModelFileDTO,
  type HfModelPlanDTO,
  type HuggingFaceStatusDTO,
} from '@orbit/shared';
import { audit, type OrbitContext } from './context';
import { claudeCodeSeat, type GatewayProvider, type GatewaySeat } from './gateways';

/*
  Your own models on rented GPUs: Hugging Face Inference Endpoints.

  Paste a model link and Orbit reads its GGUF files and Hugging Face's GPU list (both public, no
  token needed), works out which GPUs each file fits on, and shows the hourly prices. With a
  Hugging Face token it creates the endpoint (llama.cpp, private to your token, sleeping after
  some minutes without use so it stops costing), wakes it when a session needs it, and lets you
  pause or delete it. Sessions on it run in Claude Code's tools through llama.cpp's
  Anthropic-compatible API, with your Hugging Face token: never your Claude login.
*/

const SECRET = 'huggingface.token';
/** llama.cpp's own CUDA server image, the one Hugging Face uses for GGUF models. */
const LLAMACPP_IMAGE = 'ghcr.io/ggml-org/llama.cpp:server-cuda';
/** Claude Code's instructions and tool descriptions alone are about 25,000 tokens. */
export const HF_CONTEXT_TOKENS = 65_536;
const HARDWARE_TTL_MS = 30 * 60_000;
const ACCOUNT_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;
/** How long Orbit waits for an endpoint to wake or start. */
const WAKE_LIMIT_MS = 25 * 60_000;
const POLL_MS = 10_000;

interface RawEndpoint {
  name: string;
  type?: string;
  provider?: { vendor?: string; region?: string };
  compute?: { instanceType?: string; instanceSize?: string; scaling?: { minReplica?: number; scaleToZeroTimeout?: number | null } };
  model?: { repository?: string; framework?: string; image?: Record<string, { modelPath?: string } | undefined> };
  status?: { state?: HfEndpointState; message?: string; url?: string | null; readyReplica?: number; errorMessage?: string | null; lastUsedAt?: string | null };
  tags?: string[];
}

export class HuggingFaceService implements GatewayProvider {
  readonly id = 'huggingface' as const;
  readonly label = 'Hugging Face';
  readonly servedBy = 'running on the developer’s own Hugging Face Inference Endpoint';

  private hardwareCache: { at: number; list: HfHardwareDTO[] } | null = null;
  private account: { at: number; name: string; canManage: boolean } | null = null;
  private known = new Map<string, HfEndpointDTO>();

  constructor(private readonly ctx: OrbitContext) {
    registerSecret(this.token());
  }

  private get hub(): string {
    return (this.ctx.env.ORBIT_HF_HUB_URL?.trim() || 'https://huggingface.co').replace(/\/+$/, '');
  }

  private get api(): string {
    return (this.ctx.env.ORBIT_HF_ENDPOINTS_URL?.trim() || 'https://api.endpoints.huggingface.cloud').replace(/\/+$/, '');
  }

  private token(): string | null {
    return this.ctx.secrets.get(SECRET);
  }

  // ---------------------------------------------------------------------------
  // Account

  /** Checks the token with Hugging Face, then keeps it in Orbit's secrets file. */
  async connect(input: string): Promise<HuggingFaceStatusDTO> {
    const token = input.trim();
    if (!/^hf_[A-Za-z0-9]{20,}$/.test(token)) throw new OrbitError('VALIDATION', 'That does not look like a Hugging Face token.', { hint: 'Create one at huggingface.co/settings/tokens. It starts with hf_.' });
    const who = await this.whoami(token);
    unregisterSecret(this.token());
    this.ctx.secrets.set(SECRET, token);
    registerSecret(token);
    this.account = { at: Date.now(), ...who };
    audit(this.ctx, { actor: 'user', action: 'huggingface.connect', target: who.name, summary: `Connected Hugging Face as ${who.name}` });
    return this.status();
  }

  disconnect(): HuggingFaceStatusDTO {
    const token = this.token();
    if (token) {
      this.ctx.secrets.delete(SECRET);
      unregisterSecret(token);
      audit(this.ctx, { actor: 'user', action: 'huggingface.disconnect', target: null, summary: 'Disconnected Hugging Face (your endpoints keep running until you pause or delete them on huggingface.co)' });
    }
    this.account = null;
    this.known.clear();
    return { connected: false, account: null, canManage: false, endpoints: [], error: null };
  }

  async status(): Promise<HuggingFaceStatusDTO> {
    const token = this.token();
    if (!token) return { connected: false, account: null, canManage: false, endpoints: [], error: null };
    try {
      const who = await this.me(token);
      const endpoints = await this.list(token, who.name);
      return { connected: true, account: who.name, canManage: who.canManage, endpoints, error: null };
    } catch (err) {
      return { connected: true, account: this.account?.name ?? null, canManage: this.account?.canManage ?? false, endpoints: [...this.known.values()], error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // A model link: its files, the GPUs that fit, and what they cost

  async plan(input: string): Promise<HfModelPlanDTO> {
    const repository = parseHfRepository(input);
    if (!repository) throw new OrbitError('VALIDATION', 'Paste a Hugging Face model link, like https://huggingface.co/owner/model.');
    const token = this.token();
    // Resolve the model first: a missing tree must not race the more useful model error.
    const info = await this.json<{ gated?: boolean | string; tags?: string[]; cardData?: { license?: string }; gguf?: { chat_template?: string } }>(`${this.hub}/api/models/${repository}`, token).catch((err: OrbitError) => {
      throw err.code === 'NOT_FOUND' ? new OrbitError('NOT_FOUND', `Hugging Face has no model "${repository}", or it is private.`) : err;
    });
    const [tree, hardware] = await Promise.all([
      this.json<{ type: string; path: string; size?: number; lfs?: { size?: number } }[]>(`${this.hub}/api/models/${repository}/tree/main?recursive=true`, token),
      this.hardware(),
    ]);
    const files: HfModelFileDTO[] = tree
      .filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path) && !/(^|\/)mmproj/i.test(f.path))
      .map((f) => {
        const sizeGb = round1((f.lfs?.size ?? f.size ?? 0) / 1e9);
        return { path: f.path, sizeGb, quant: quantOf(f.path), needsGb: needsGb(sizeGb) };
      })
      // Split files (model-00001-of-00003.gguf) need every part: Orbit offers single-file models only.
      .filter((f) => !/-\d{5}-of-\d{5}\.gguf$/i.test(f.path) && f.sizeGb > 0)
      .sort((a, b) => a.sizeGb - b.sizeGb);
    if (!files.length) {
      throw new OrbitError('PRECONDITION', `${repository} has no single-file GGUF version.`, { hint: 'Orbit runs models with llama.cpp, which needs a GGUF file. Look for a "-GGUF" version of this model on Hugging Face.' });
    }
    const file = suggestFile(files);
    const fit = cheapestFit(hardware, file.needsGb);
    return {
      repository,
      tools: (info.gguf?.chat_template ?? '').includes('tools'),
      license: info.cardData?.license ?? info.tags?.find((t) => t.startsWith('license:'))?.slice(8) ?? null,
      gated: !!info.gated,
      files,
      hardware,
      suggested: { file: file.path, hardwareId: fit?.id ?? null },
      name: endpointName(repository),
    };
  }

  // ---------------------------------------------------------------------------
  // Endpoints

  /** Rents the GPU: creates a private llama.cpp endpoint that sleeps after `sleepAfterMinutes` without use. */
  async create(input: { repository: string; file: string; hardwareId: string; name?: string; sleepAfterMinutes?: number }): Promise<HuggingFaceStatusDTO> {
    const token = this.needToken();
    const who = await this.me(token);
    const repository = parseHfRepository(input.repository);
    if (!repository) throw new OrbitError('VALIDATION', 'That is not a Hugging Face model.');
    if (!/\.gguf$/i.test(input.file)) throw new OrbitError('VALIDATION', 'Pick one of the model’s GGUF files.');
    const hw = (await this.hardware()).find((h) => h.id === input.hardwareId);
    if (!hw) throw new OrbitError('VALIDATION', 'That GPU is not offered by Hugging Face right now. Pick another.');
    const name = (input.name?.trim() || endpointName(repository)).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name)) throw new OrbitError('VALIDATION', 'Endpoint names use lowercase letters, numbers and dashes, at most 32 characters.');
    const sleep = Math.min(Math.max(Math.round(input.sleepAfterMinutes ?? 15), 5), 24 * 60);
    const body = {
      name,
      // Only your Hugging Face token can call it.
      type: 'authenticated',
      provider: { vendor: hw.vendor, region: hw.region },
      compute: { accelerator: 'gpu', instanceType: hw.instanceType, instanceSize: hw.instanceSize, scaling: { minReplica: 0, maxReplica: 1, scaleToZeroTimeout: sleep } },
      model: {
        repository,
        framework: 'llamacpp',
        task: 'text-generation',
        image: { llamacpp: { url: LLAMACPP_IMAGE, modelPath: input.file } },
        // Room for Claude Code's instructions and a real conversation, one request at a time, and
        // the model's own chat template (that is what makes tool use work).
        args: ['--ctx-size', String(HF_CONTEXT_TOKENS), '--parallel', '1', '--jinja'],
        env: {},
      },
      tags: ['orbit'],
    };
    const res = await this.call('POST', `${this.api}/v2/endpoint/${encodeURIComponent(who.name)}`, token, body);
    if (!res.ok) throw await endpointError(res, 'create the endpoint');
    audit(this.ctx, {
      actor: 'user',
      action: 'huggingface.endpoint.create',
      target: name,
      summary: `Created the Hugging Face endpoint ${name}: ${repository} (${input.file}) on ${hw.label}, $${hw.pricePerHour}/hour while awake, sleeps after ${sleep} minutes without use`,
    });
    return this.status();
  }

  /** Stops it until you resume it: no cost while paused. */
  async pause(name: string): Promise<HuggingFaceStatusDTO> {
    await this.act('POST', name, '/pause', 'pause');
    audit(this.ctx, { actor: 'user', action: 'huggingface.endpoint.pause', target: name, summary: `Paused the Hugging Face endpoint ${name}` });
    return this.status();
  }

  async resume(name: string): Promise<HuggingFaceStatusDTO> {
    await this.act('POST', name, '/resume', 'resume');
    return this.status();
  }

  /** Deletes the endpoint on Hugging Face (the model files stay on the Hub). */
  async remove(name: string): Promise<HuggingFaceStatusDTO> {
    await this.act('DELETE', name, '', 'delete');
    this.known.delete(name);
    const { [name]: _gone, ...rest } = this.ctx.settings.get().huggingface.instructions;
    this.ctx.settings.update({ huggingface: { instructions: rest } });
    audit(this.ctx, { actor: 'user', action: 'huggingface.endpoint.delete', target: name, summary: `Deleted the Hugging Face endpoint ${name}` });
    return this.status();
  }

  /** Your master prompt for one endpoint (empty text removes it). */
  async setInstructions(name: string, text: string): Promise<HuggingFaceStatusDTO> {
    const clean = text.replace(/\r\n/g, '\n').trim();
    if (clean.length > MAX_MODEL_INSTRUCTIONS) throw new OrbitError('VALIDATION', `Instructions are limited to ${MAX_MODEL_INSTRUCTIONS.toLocaleString('en')} characters.`);
    const { [name]: _old, ...rest } = this.ctx.settings.get().huggingface.instructions;
    this.ctx.settings.update({ huggingface: { instructions: clean ? { ...rest, [name]: clean } : rest } });
    return this.status();
  }

  // ---------------------------------------------------------------------------
  // As a session's AI

  async seat(model: string | null, opts: { onProgress?: (message: string) => void; signal?: AbortSignal; wake?: boolean } = {}): Promise<GatewaySeat> {
    const token = this.needToken();
    const who = await this.me(token);
    let name = isHfModel(model) ? model.slice(HF_PREFIX.length) : null;
    if (!name) {
      const first = (await this.list(token, who.name)).find((e) => e.usable);
      if (!first) throw new OrbitError('PRECONDITION', 'You have no Hugging Face endpoint to use yet. Create one on the Agents page.');
      name = first.name;
    }
    const ep = await this.awaken(token, who.name, name, opts);
    const gateway: AgentGateway = { name: this.label, baseUrl: ep.url!, token, model: ep.repository, tools: true, compatibility: 'llamacpp' };
    return claudeCodeSeat(this.ctx, this.label, `${HF_PREFIX}${name}`, gateway);
  }

  info(model: string): { name: string; instructions: string } {
    const name = isHfModel(model) ? model.slice(HF_PREFIX.length) : model;
    const ep = this.known.get(name);
    const shown = ep ? `${ep.repository.split('/').pop()}${ep.file ? ` (${quantOf(ep.file)})` : ''}` : name;
    return { name: shown, instructions: this.ctx.settings.get().huggingface.instructions[name] ?? '' };
  }

  /**
   * Makes sure the endpoint answers: resumes a paused one, wakes a sleeping one (a request does
   * that), and waits while it starts, saying what is happening. Fails clearly when it cannot run.
   */
  private async awaken(token: string, ns: string, name: string, opts: { onProgress?: (message: string) => void; signal?: AbortSignal; wake?: boolean }): Promise<HfEndpointDTO> {
    const started = Date.now();
    let poked = false;
    let resumed = false;
    let waitedOnce = false;
    let lastNote = 0;
    const note = (message: string) => {
      if (Date.now() - lastNote < 30_000 && lastNote) return;
      lastNote = Date.now();
      opts.onProgress?.(message);
    };
    for (;;) {
      if (opts.signal?.aborted) throw new OrbitError('CONFLICT', 'Stopped while waiting for the Hugging Face endpoint.');
      const ep = await this.get(token, ns, name);
      if (!ep.usable) throw new OrbitError('PRECONDITION', `The endpoint ${name} does not serve a llama.cpp text model, so Orbit cannot run sessions on it.`);
      const waited = Math.round((Date.now() - started) / 60_000);
      if (ep.state === 'running' && ep.url) {
        // Only worth saying when it was not running a moment ago.
        if (poked || resumed || waitedOnce) opts.onProgress?.(`Your Hugging Face endpoint ${name} is ready.`);
        return ep;
      }
      if (ep.state === 'failed' || ep.state === 'updateFailed') {
        throw new OrbitError('EXTERNAL', `The Hugging Face endpoint ${name} failed: ${ep.message ?? 'no reason given'}`, { hint: 'Open it on endpoints.huggingface.co to see its logs. "Out of memory" means it needs a bigger GPU or a smaller file.' });
      }
      if (opts.wake === false) throw new OrbitError('PRECONDITION', `The Hugging Face endpoint ${name} is not running.`);
      if (ep.state === 'paused' && !resumed) {
        resumed = true;
        await this.act('POST', name, '/resume', 'resume');
        opts.onProgress?.(`Resuming your Hugging Face endpoint ${name} (${ep.hardware.label}${ep.hardware.pricePerHour != null ? `, $${ep.hardware.pricePerHour}/hour while awake` : ''}). Starting a GPU usually takes 2 to 6 minutes.`);
      } else if (ep.state === 'scaledToZero' && ep.url && !poked) {
        // A request wakes a sleeping endpoint.
        poked = true;
        void this.call('GET', `${ep.url}/health`, token).catch(() => undefined);
        opts.onProgress?.(`Waking your Hugging Face endpoint ${name} (${ep.hardware.label}${ep.hardware.pricePerHour != null ? `, $${ep.hardware.pricePerHour}/hour while awake` : ''}). It slept to save money; waking usually takes 2 to 6 minutes.`);
      } else {
        note(`Still starting your Hugging Face endpoint${waited ? ` (${waited} min so far)` : ''}: ${ep.message || ep.state}.`);
      }
      if (Date.now() - started > WAKE_LIMIT_MS) throw new OrbitError('EXTERNAL', `The Hugging Face endpoint ${name} did not start within ${WAKE_LIMIT_MS / 60_000} minutes.`, { hint: 'Check it on endpoints.huggingface.co.' });
      waitedOnce = true;
      await sleep(Number(this.ctx.env.ORBIT_HF_POLL_MS) || POLL_MS, opts.signal);
    }
  }

  // ---------------------------------------------------------------------------

  private needToken(): string {
    const token = this.token();
    if (!token) throw new OrbitError('PRECONDITION', 'Hugging Face is not connected. Add your Hugging Face token on the Agents page.');
    return token;
  }

  private async me(token: string): Promise<{ name: string; canManage: boolean }> {
    if (this.account && Date.now() - this.account.at < ACCOUNT_TTL_MS) return this.account;
    const who = await this.whoami(token);
    this.account = { at: Date.now(), ...who };
    return who;
  }

  private async whoami(token: string): Promise<{ name: string; canManage: boolean }> {
    const res = await this.call('GET', `${this.hub}/api/whoami-v2`, token).catch((err: Error) => {
      throw new OrbitError('EXTERNAL', `Could not reach Hugging Face: ${err.message}`);
    });
    if (res.status === 401 || res.status === 403) throw new OrbitError('VALIDATION', 'Hugging Face did not accept this token.', { hint: 'Check that you copied all of it at huggingface.co/settings/tokens.' });
    if (!res.ok) throw new OrbitError('EXTERNAL', `Hugging Face answered ${res.status} when checking the token.`);
    const body = (await res.json()) as { name?: string; auth?: { accessToken?: { role?: string; fineGrained?: unknown } } };
    if (!body.name) throw new OrbitError('EXTERNAL', 'Hugging Face did not say whose token this is.');
    const at = body.auth?.accessToken;
    // A write token, or a fine-grained one allowed to manage Inference Endpoints.
    const canManage = at?.role === 'write' || JSON.stringify(at?.fineGrained ?? '').includes('inference.endpoints.write');
    return { name: body.name, canManage };
  }

  private async hardware(): Promise<HfHardwareDTO[]> {
    if (this.hardwareCache && Date.now() - this.hardwareCache.at < HARDWARE_TTL_MS) return this.hardwareCache.list;
    const body = await this.json<{ vendors?: { name: string; regions?: { name: string; label: string; status?: string; computes?: Record<string, unknown>[] }[] }[] }>(`${this.api}/v2/provider`, null);
    const list: HfHardwareDTO[] = [];
    for (const v of body.vendors ?? []) {
      for (const r of v.regions ?? []) {
        if (r.status && r.status !== 'available') continue;
        for (const c of r.computes ?? []) {
          if (c.accelerator !== 'gpu') continue;
          const status = String(c.status ?? '');
          const memory = (Number(c.gpuMemoryGb) || 0) * (Number(c.numAccelerators) || 1);
          list.push({
            id: String(c.id),
            vendor: v.name,
            region: r.name,
            regionLabel: r.label,
            instanceType: String(c.instanceType),
            instanceSize: String(c.instanceSize),
            label: String(c.architecture ?? c.instanceType),
            gpuMemoryGb: memory || Number(c.gpuMemoryGb) || 0,
            pricePerHour: Number(c.pricePerHour) || 0,
            available: status === 'available' || status === 'low_availability',
          });
        }
      }
    }
    list.sort((a, b) => a.pricePerHour - b.pricePerHour || a.gpuMemoryGb - b.gpuMemoryGb);
    this.hardwareCache = { at: Date.now(), list };
    return list;
  }

  private async list(token: string, ns: string): Promise<HfEndpointDTO[]> {
    const body = await this.json<{ items?: RawEndpoint[] }>(`${this.api}/v2/endpoint/${encodeURIComponent(ns)}`, token);
    const hw = await this.hardware().catch(() => []);
    const out = (body.items ?? []).map((e) => this.dto(e, hw));
    this.known = new Map(out.map((e) => [e.name, e]));
    return out;
  }

  private async get(token: string, ns: string, name: string): Promise<HfEndpointDTO> {
    const raw = await this.json<RawEndpoint>(`${this.api}/v2/endpoint/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, token).catch((err: OrbitError) => {
      throw err.code === 'NOT_FOUND' ? new OrbitError('NOT_FOUND', `There is no Hugging Face endpoint called ${name} any more.`, { hint: 'It may have been deleted. Pick another AI or model for this session.' }) : err;
    });
    const ep = this.dto(raw, await this.hardware().catch(() => []));
    this.known.set(ep.name, ep);
    return ep;
  }

  private dto(e: RawEndpoint, hw: HfHardwareDTO[]): HfEndpointDTO {
    const llama = e.model?.image?.llamacpp;
    const match = hw.find((h) => h.vendor === e.provider?.vendor && h.region === e.provider?.region && h.instanceType === e.compute?.instanceType && h.instanceSize === e.compute?.instanceSize);
    const scaling = e.compute?.scaling;
    return {
      id: `${HF_PREFIX}${e.name}`,
      name: e.name,
      repository: e.model?.repository ?? '',
      file: llama?.modelPath ?? null,
      state: e.status?.state ?? 'pending',
      message: e.status?.errorMessage || e.status?.message || null,
      url: e.status?.url || null,
      hardware: { label: match?.label ?? `${e.compute?.instanceType ?? '?'} ${e.compute?.instanceSize ?? ''}`.trim(), gpuMemoryGb: match?.gpuMemoryGb ?? null, pricePerHour: match?.pricePerHour ?? null, region: e.provider?.region ?? '' },
      sleepAfterMinutes: scaling?.minReplica === 0 ? (scaling.scaleToZeroTimeout ?? 15) : null,
      usable: !!llama || e.model?.framework === 'llamacpp',
      createdByOrbit: !!e.tags?.includes('orbit'),
      instructions: this.ctx.settings.get().huggingface.instructions[e.name] ?? '',
      lastUsedAt: e.status?.lastUsedAt ?? null,
    };
  }

  private async act(method: 'POST' | 'DELETE', name: string, path: string, what: string): Promise<void> {
    const token = this.needToken();
    const who = await this.me(token);
    const res = await this.call(method, `${this.api}/v2/endpoint/${encodeURIComponent(who.name)}/${encodeURIComponent(name)}${path}`, token);
    if (!res.ok) throw await endpointError(res, `${what} ${name}`);
  }

  private async json<T>(url: string, token: string | null): Promise<T> {
    const res = await this.call('GET', url, token).catch((err: Error) => {
      throw new OrbitError('EXTERNAL', `Could not reach Hugging Face: ${err.message}`);
    });
    if (res.status === 404) throw new OrbitError('NOT_FOUND', 'Not found on Hugging Face.');
    if (res.status === 401 || res.status === 403) throw new OrbitError('FORBIDDEN', 'Hugging Face refused: check your token on the Agents page.');
    if (!res.ok) throw new OrbitError('EXTERNAL', `Hugging Face answered ${res.status}.`);
    return (await res.json()) as T;
  }

  private call(method: string, url: string, token: string | null, body?: unknown): Promise<Response> {
    return fetch(url, {
      method,
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}

/**
 * GPU memory a GGUF file needs: the weights, plus a 64k-token context (often 4 to 6 GB for a model
 * this size) and llama.cpp's own buffers. On the safe side: running out of memory means a failed
 * endpoint, a bit of spare room only means a slightly dearer GPU.
 */
export function needsGb(sizeGb: number): number {
  return round1(sizeGb * 1.1 + 5);
}

/** The quantization in a GGUF file name: Q4_K_M, IQ3_M, Q8_0, BF16… */
export function quantOf(file: string): string {
  return /(I?Q\d+_[A-Z0-9]+(?:_[A-Z])?|BF16|F16|F32)/i.exec(file.split('/').pop() ?? file)?.[1]?.toUpperCase() ?? 'GGUF';
}

/** A good default: Q4_K_M (the usual size/quality balance), else the closest smaller-or-similar one. */
export function suggestFile(files: HfModelFileDTO[]): HfModelFileDTO {
  const plain = files.filter((f) => !/[-_.]MTP[-_.]/i.test(f.path));
  const pool = plain.length ? plain : files;
  for (const q of ['Q4_K_M', 'Q4_K_S', 'IQ4_XS', 'Q5_K_M', 'Q3_K_M', 'IQ3_M']) {
    const hit = pool.find((f) => f.quant === q);
    if (hit) return hit;
  }
  return pool[Math.floor(pool.length / 2)] ?? files[0]!;
}

/** The cheapest GPU Hugging Face can rent now with enough memory. */
export function cheapestFit(hardware: HfHardwareDTO[], needs: number): HfHardwareDTO | null {
  return hardware.filter((h) => h.available && h.gpuMemoryGb >= needs).sort((a, b) => a.pricePerHour - b.pricePerHour || a.gpuMemoryGb - b.gpuMemoryGb)[0] ?? null;
}

/** A valid endpoint name from the model's: lowercase, dashes, at most 32 characters, a little unique. */
export function endpointName(repository: string): string {
  const base = (repository.split('/').pop() ?? 'model')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 27)
    .replace(/-+$/, '');
  return `${base || 'model'}-${Math.random().toString(36).slice(2, 6)}`;
}

async function endpointError(res: Response, what: string): Promise<OrbitError> {
  const text = await res.text().catch(() => '');
  let message = text;
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    message = typeof j.error === 'string' ? j.error : typeof j.message === 'string' ? j.message : text;
  } catch {
    /* plain text */
  }
  message = message.slice(0, 400);
  // Endpoint billing failures can be 403 too. Do not mistake them for missing token scopes.
  if (res.status === 402 || (res.status === 403 && /payment method required/i.test(message))) return new OrbitError('PRECONDITION', `Hugging Face needs a payment method before it can ${what}.`, { hint: 'Check your payment method at huggingface.co/settings/billing, then try again.' });
  if (res.status === 401 || res.status === 403) return new OrbitError('FORBIDDEN', `Your Hugging Face token may not ${what}${message ? `: ${message}` : '.'}`, { hint: 'Use a token with write access, or a fine-grained one allowed to manage Inference Endpoints.' });
  if (res.status === 409) return new OrbitError('CONFLICT', `Could not ${what}: ${message || 'an endpoint with that name already exists.'}`);
  return new OrbitError('EXTERNAL', `Could not ${what} (Hugging Face answered ${res.status})${message ? `: ${message}` : '.'}`);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

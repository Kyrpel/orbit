import { ProviderError } from '@orbit/integrations';

export const ASANA_API = 'https://app.asana.com/api/1.0';

export interface AsanaClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Asana allows 150 req/min on free domains and 1500 on paid domains. */
  requestsPerMinute?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent?: string;
  /** Upper bound for a single Retry-After wait. */
  maxRetryAfterMs?: number;
}

export interface AsanaUser {
  gid: string;
  name?: string;
  email?: string;
  resource_type?: string;
}

export interface AsanaWorkspace {
  gid: string;
  name: string;
}

export interface AsanaProject {
  gid: string;
  name: string;
  permalink_url?: string;
  archived?: boolean;
  workspace?: { gid: string; name?: string };
}

export interface AsanaTask {
  gid: string;
  name: string;
  notes?: string;
  permalink_url?: string;
  completed?: boolean;
  assignee?: AsanaUser | null;
  created_at?: string;
  modified_at?: string;
  memberships?: { project?: { gid: string } }[];
  projects?: { gid: string }[];
}

export interface AsanaStory {
  gid: string;
  text?: string;
  created_at: string;
  created_by?: AsanaUser | null;
  type?: string;
  resource_subtype?: string;
  target?: { gid: string } | null;
}

export interface AsanaEvent {
  user: AsanaUser | null;
  created_at: string;
  action: 'changed' | 'added' | 'removed' | 'deleted' | 'undeleted';
  resource: { gid: string; resource_type: string; resource_subtype?: string; name?: string };
  parent: { gid: string; resource_type: string; resource_subtype?: string } | null;
  change?: { field: string; action: string };
}

export interface AsanaEventsPage {
  data: AsanaEvent[];
  sync: string;
  has_more: boolean;
}

/** Thrown when Asana answers 412 for an events request: the sync token is new, invalid or expired. */
export class SyncTokenExpiredError extends Error {
  readonly newSyncToken: string;
  constructor(newSyncToken: string) {
    super('Asana sync token is invalid or expired');
    this.name = 'SyncTokenExpiredError';
    this.newSyncToken = newSyncToken;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    return () => {
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

const TASK_FIELDS = 'gid,name,notes,permalink_url,completed,assignee.name,assignee.email,created_at,modified_at,memberships.project.gid,projects.gid';
const STORY_FIELDS = 'gid,text,created_at,created_by.name,created_by.email,type,resource_subtype,target.gid';
const PROJECT_FIELDS = 'gid,name,permalink_url,archived,workspace.gid,workspace.name';

/**
 * Minimal Asana REST client: pagination, Retry-After handling, exponential
 * backoff, a per-minute request budget and concurrency limits that stay under
 * Asana's documented caps (50 concurrent reads, 15 concurrent writes).
 */
export class AsanaClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly perMinute: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRetryAfterMs: number;
  private readonly userAgent: string;
  private readonly sent: number[] = [];
  private readonly reads = new Semaphore(10);
  private readonly writes = new Semaphore(4);

  constructor(private readonly opts: AsanaClientOptions) {
    this.base = (opts.baseUrl ?? ASANA_API).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.perMinute = opts.requestsPerMinute ?? 150;
    this.maxRetries = opts.maxRetries ?? 4;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 65_000;
    this.userAgent = opts.userAgent ?? 'orbit-dev/0.1.0';
  }

  private async throttle(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.sent.length && t - (this.sent[0] as number) >= 60_000) this.sent.shift();
      if (this.sent.length < this.perMinute) {
        this.sent.push(t);
        return;
      }
      await this.sleep(60_000 - (t - (this.sent[0] as number)) + 25);
    }
  }

  private url(path: string, query?: Query): string {
    const u = new URL(`${this.base}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: { query?: Query; body?: unknown; expect412?: boolean } = {}): Promise<{ status: number; body: { data?: T } & Record<string, unknown> }> {
    const release = await (method === 'GET' ? this.reads : this.writes).acquire();
    try {
      let attempt = 0;
      for (;;) {
        await this.throttle();
        let res: Response;
        try {
          res = await this.fetchImpl(this.url(path, opts.query), {
            method,
            headers: {
              Authorization: `Bearer ${this.opts.token}`,
              Accept: 'application/json',
              'User-Agent': this.userAgent,
              ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          });
        } catch (err) {
          if (attempt < this.maxRetries) {
            await this.sleep(this.backoff(attempt++));
            continue;
          }
          throw new ProviderError('network', `Could not reach Asana: ${(err as Error).message}`, { cause: err });
        }

        const text = await res.text();
        let body: Record<string, unknown> = {};
        if (text) {
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            body = { raw: text.slice(0, 500) };
          }
        }

        if (res.ok) return { status: res.status, body: body as { data?: T } & Record<string, unknown> };

        if (res.status === 412 && opts.expect412) {
          const sync = typeof body.sync === 'string' ? body.sync : null;
          if (sync) throw new SyncTokenExpiredError(sync);
        }

        const message = asanaErrorMessage(body) ?? res.statusText;
        if (res.status === 429) {
          const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'));
          if (attempt < this.maxRetries) {
            attempt++;
            await this.sleep(Math.min(this.maxRetryAfterMs, (retryAfterSec ?? 30) * 1000 + 100));
            continue;
          }
          throw new ProviderError('rate_limited', `Asana rate limit reached. ${message}`, { status: 429, retryAfterSec });
        }
        if (res.status >= 500) {
          if (attempt < this.maxRetries) {
            await this.sleep(this.backoff(attempt++));
            continue;
          }
          throw new ProviderError('unavailable', `Asana is unavailable (${res.status}). ${message}`, { status: res.status });
        }
        if (res.status === 401) throw new ProviderError('auth', 'Asana rejected the access token (401). It may have been revoked or expired.', { status: 401 });
        if (res.status === 402) throw new ProviderError('payment_required', `This Asana feature needs a paid plan (402). ${message}`, { status: 402 });
        if (res.status === 403) throw new ProviderError('forbidden', `Asana denied access (403). ${message}`, { status: 403 });
        if (res.status === 404) throw new ProviderError('not_found', `Not found in Asana (404). ${message}`, { status: 404 });
        throw new ProviderError('invalid', `Asana request failed (${res.status}). ${message}`, { status: res.status });
      }
    } finally {
      release();
    }
  }

  private backoff(attempt: number): number {
    return Math.min(30_000, 500 * 2 ** attempt + Math.floor(Math.random() * 250));
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    const res = await this.request<T>('GET', path, query ? { query } : {});
    return res.body.data as T;
  }

  /** Follows Asana's offset pagination. Stops after `maxItems`. */
  async list<T>(path: string, query: Query = {}, maxItems = 2000): Promise<T[]> {
    const out: T[] = [];
    let offset: string | undefined;
    do {
      const res = await this.request<T[]>('GET', path, { query: { ...query, limit: 100, offset } });
      out.push(...((res.body.data as T[] | undefined) ?? []));
      const next = res.body.next_page as { offset?: string } | null | undefined;
      offset = next?.offset ?? undefined;
    } while (offset && out.length < maxItems);
    return out.slice(0, maxItems);
  }

  getMe(): Promise<AsanaUser> {
    return this.get<AsanaUser>('/users/me', { opt_fields: 'gid,name,email' });
  }

  listWorkspaces(): Promise<AsanaWorkspace[]> {
    return this.list<AsanaWorkspace>('/workspaces', { opt_fields: 'gid,name' });
  }

  listProjects(workspaceGid: string): Promise<AsanaProject[]> {
    return this.list<AsanaProject>('/projects', { workspace: workspaceGid, archived: false, opt_fields: PROJECT_FIELDS });
  }

  getProject(projectGid: string): Promise<AsanaProject> {
    return this.get<AsanaProject>(`/projects/${encodeURIComponent(projectGid)}`, { opt_fields: PROJECT_FIELDS });
  }

  listProjectTasks(projectGid: string, opts: { includeCompleted?: boolean; maxItems?: number } = {}): Promise<AsanaTask[]> {
    return this.list<AsanaTask>(
      `/projects/${encodeURIComponent(projectGid)}/tasks`,
      { opt_fields: TASK_FIELDS, ...(opts.includeCompleted ? {} : { completed_since: 'now' }) },
      opts.maxItems ?? 500,
    );
  }

  getTask(taskGid: string): Promise<AsanaTask> {
    return this.get<AsanaTask>(`/tasks/${encodeURIComponent(taskGid)}`, { opt_fields: TASK_FIELDS });
  }

  listStories(taskGid: string): Promise<AsanaStory[]> {
    return this.list<AsanaStory>(`/tasks/${encodeURIComponent(taskGid)}/stories`, { opt_fields: STORY_FIELDS }, 1000);
  }

  getStory(storyGid: string): Promise<AsanaStory> {
    return this.get<AsanaStory>(`/stories/${encodeURIComponent(storyGid)}`, { opt_fields: STORY_FIELDS });
  }

  async createComment(taskGid: string, text: string): Promise<AsanaStory> {
    const res = await this.request<AsanaStory>('POST', `/tasks/${encodeURIComponent(taskGid)}/stories`, {
      body: { data: { text } },
      query: { opt_fields: STORY_FIELDS },
    });
    return res.body.data as AsanaStory;
  }

  /** Updates a task's name and/or plain-text notes. */
  async updateTask(taskGid: string, data: { name?: string; notes?: string }): Promise<AsanaTask> {
    const res = await this.request<AsanaTask>('PUT', `/tasks/${encodeURIComponent(taskGid)}`, {
      body: { data },
      query: { opt_fields: TASK_FIELDS },
    });
    return res.body.data as AsanaTask;
  }

  /** Fetches an events page. Throws `SyncTokenExpiredError` (carrying a fresh token) on 412. */
  async getEvents(resourceGid: string, syncToken: string | null): Promise<AsanaEventsPage> {
    const res = await this.request<AsanaEvent[]>('GET', '/events', {
      query: { resource: resourceGid, ...(syncToken ? { sync: syncToken } : {}) },
      expect412: true,
    });
    return {
      data: (res.body.data as AsanaEvent[] | undefined) ?? [],
      sync: typeof res.body.sync === 'string' ? res.body.sync : (syncToken ?? ''),
      has_more: res.body.has_more === true,
    };
  }

  /** Obtains an initial sync token. Asana answers the first request with 412 + token by design. */
  async initialSyncToken(resourceGid: string): Promise<string> {
    try {
      const page = await this.getEvents(resourceGid, null);
      return page.sync;
    } catch (err) {
      if (err instanceof SyncTokenExpiredError) return err.newSyncToken;
      throw err;
    }
  }
}

export function asanaErrorMessage(body: Record<string, unknown>): string | null {
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { message?: string };
    if (first?.message) return first.message;
  }
  return null;
}

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}

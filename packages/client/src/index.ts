import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ActivityItem,
  AgentRoleDTO,
  DiffStats,
  DoctorReport,
  ExternalProjectDTO,
  ExternalTaskDTO,
  IntegrationDTO,
  MissionDetailDTO,
  MissionEventDTO,
  MissionSummaryDTO,
  OverviewDTO,
  ReceiptDTO,
  RepoDTO,
  Settings,
  SettingsPatch,
  WorkspaceDTO,
} from '@orbit/shared';

export class OrbitClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string | undefined;
  constructor(code: string, message: string, status: number, hint?: string) {
    super(message);
    this.name = 'OrbitClientError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export interface ServerInfo {
  url: string;
  token: string;
  pid?: number;
}

function home(): string {
  return process.env.ORBIT_HOME ? path.resolve(process.env.ORBIT_HOME) : path.join(os.homedir(), '.orbit');
}

/** Finds the local Orbit server from ORBIT_URL/ORBIT_TOKEN or the files `orbit start` writes. */
export function discoverServer(orbitHome = home()): ServerInfo | null {
  const envUrl = process.env.ORBIT_URL;
  let token = process.env.ORBIT_TOKEN ?? null;
  if (!token) {
    const authFile = path.join(orbitHome, 'auth.json');
    if (existsSync(authFile)) {
      try {
        token = (JSON.parse(readFileSync(authFile, 'utf8')) as { token?: string }).token ?? null;
      } catch {
        token = null;
      }
    }
  }
  let url = envUrl ?? null;
  let pid: number | undefined;
  if (!url) {
    const serverFile = path.join(orbitHome, 'server.json');
    if (existsSync(serverFile)) {
      try {
        const s = JSON.parse(readFileSync(serverFile, 'utf8')) as { url?: string; pid?: number };
        url = s.url ?? null;
        pid = s.pid;
      } catch {
        url = null;
      }
    }
  }
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token, ...(pid ? { pid } : {}) };
}

export class OrbitClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly clientName: 'cli' | 'mcp' | 'api' = 'cli',
  ) {}

  static fromEnvironment(clientName: 'cli' | 'mcp' | 'api' = 'cli'): OrbitClient {
    const info = discoverServer();
    if (!info) {
      throw new OrbitClientError('NOT_RUNNING', 'Orbit is not running. Start it with `orbit start` (or `pnpm orbit start` from a checkout).', 0);
    }
    return new OrbitClient(info.url, info.token, clientName);
  }

  async request<T>(method: string, route: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'X-Orbit-Client': this.clientName,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new OrbitClientError('NOT_RUNNING', `Could not reach Orbit at ${this.baseUrl} (${(err as Error).message}). Is \`orbit start\` running?`, 0);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string; hint?: string } } | undefined)?.error;
      throw new OrbitClientError(e?.code ?? 'HTTP_ERROR', e?.message ?? `HTTP ${res.status}`, res.status, e?.hint);
    }
    return data as T;
  }

  health() {
    return this.request<{ ok: boolean; version: string }>('GET', '/api/health', undefined, 5000);
  }
  doctor() {
    return this.request<DoctorReport>('GET', '/api/doctor');
  }
  overview() {
    return this.request<OverviewDTO>('GET', '/api/overview');
  }
  agents() {
    return this.request<AgentRoleDTO[]>('GET', '/api/agents');
  }
  activity(limit = 50) {
    return this.request<ActivityItem[]>('GET', `/api/activity?limit=${limit}`);
  }
  settings() {
    return this.request<Settings>('GET', '/api/settings');
  }
  updateSettings(patch: SettingsPatch) {
    return this.request<Settings>('PATCH', '/api/settings', patch);
  }
  consent(grant: boolean) {
    return this.request<Settings>('POST', '/api/consent', { grant });
  }

  repos() {
    return this.request<RepoDTO[]>('GET', '/api/repos');
  }
  repo(id: string) {
    return this.request<RepoDTO>('GET', `/api/repos/${encodeURIComponent(id)}`);
  }
  addRepo(repoPath: string, opts: { name?: string } = {}) {
    return this.request<RepoDTO>('POST', '/api/repos', { path: repoPath, ...opts });
  }
  updateRepo(id: string, patch: Partial<Pick<RepoDTO, 'name' | 'allowModify' | 'defaultBranch' | 'setupCommands' | 'verifyCommands'>>) {
    return this.request<RepoDTO>('PATCH', `/api/repos/${encodeURIComponent(id)}`, patch);
  }
  removeRepo(id: string) {
    return this.request<void>('DELETE', `/api/repos/${encodeURIComponent(id)}`);
  }

  integrations() {
    return this.request<IntegrationDTO[]>('GET', '/api/integrations');
  }
  connectAsana(token: string) {
    return this.request<IntegrationDTO>('POST', '/api/integrations/asana', { token });
  }
  workspaces(integrationId: string) {
    return this.request<WorkspaceDTO[]>('GET', `/api/integrations/${encodeURIComponent(integrationId)}/workspaces`);
  }
  remoteProjects(integrationId: string, workspaceId: string) {
    return this.request<{ id: string; name: string; connectedProjectId: string | null }[]>(
      'GET',
      `/api/integrations/${encodeURIComponent(integrationId)}/projects?workspace=${encodeURIComponent(workspaceId)}`,
    );
  }
  projects() {
    return this.request<ExternalProjectDTO[]>('GET', '/api/projects');
  }
  connectProject(integrationId: string, externalProjectId: string, repoIds: string[]) {
    return this.request<ExternalProjectDTO>('POST', '/api/projects', { integrationId, externalProjectId, repoIds });
  }
  projectTasks(projectId: string) {
    return this.request<ExternalTaskDTO[]>('GET', `/api/projects/${encodeURIComponent(projectId)}/tasks`);
  }
  runTasks(projectId: string, taskIds: string[]) {
    return this.request<{ taskId: string; missionId: string | null; created: boolean; error: string | null }[]>('POST', `/api/projects/${encodeURIComponent(projectId)}/run`, { taskIds });
  }

  missions(query: { status?: string; attention?: boolean; active?: boolean; limit?: number } = {}) {
    const p = new URLSearchParams();
    if (query.status) p.set('status', query.status);
    if (query.attention) p.set('attention', 'true');
    if (query.active) p.set('active', 'true');
    if (query.limit) p.set('limit', String(query.limit));
    const qs = p.toString();
    return this.request<MissionSummaryDTO[]>('GET', `/api/missions${qs ? `?${qs}` : ''}`);
  }
  approvals() {
    return this.request<MissionSummaryDTO[]>('GET', '/api/approvals');
  }
  createMission(input: { title?: string; description?: string; repoIds?: string[]; source?: { integrationId: string; taskId: string; projectId?: string | null }; extraInstructions?: string | null }) {
    return this.request<{ mission: MissionSummaryDTO; created: boolean }>('POST', '/api/missions', input);
  }
  mission(id: string) {
    return this.request<MissionDetailDTO>('GET', `/api/missions/${encodeURIComponent(id)}`);
  }
  events(id: string, after = 0) {
    return this.request<MissionEventDTO[]>('GET', `/api/missions/${encodeURIComponent(id)}/events?after=${after}`);
  }
  diff(id: string, missionRepoId: string) {
    return this.request<{ diff: string; truncated: boolean; stats: DiffStats | null }>('GET', `/api/missions/${encodeURIComponent(id)}/diff?missionRepoId=${encodeURIComponent(missionRepoId)}`);
  }
  receipt(id: string) {
    return this.request<ReceiptDTO>('GET', `/api/missions/${encodeURIComponent(id)}/receipt`);
  }
  approveScope(id: string, body: { repoIds?: string[]; notes?: string | null } = {}) {
    return this.request<MissionSummaryDTO>('POST', `/api/missions/${encodeURIComponent(id)}/approve-scope`, body);
  }
  requestChanges(id: string, notes: string) {
    return this.request<MissionSummaryDTO>('POST', `/api/missions/${encodeURIComponent(id)}/request-changes`, { notes });
  }
  approveChanges(id: string) {
    return this.request<MissionSummaryDTO>('POST', `/api/missions/${encodeURIComponent(id)}/approve-changes`, {});
  }
  publish(id: string, body: { missionRepoId: string; title?: string; body?: string; draft?: boolean }) {
    return this.request<MissionSummaryDTO>('POST', `/api/missions/${encodeURIComponent(id)}/publish`, body);
  }
  finishLocal(id: string) {
    return this.request<MissionSummaryDTO>('POST', `/api/missions/${encodeURIComponent(id)}/finish-local`, {});
  }
  cancel(id: string, reason?: string) {
    return this.request<MissionSummaryDTO>('POST', `/api/missions/${encodeURIComponent(id)}/cancel`, { reason: reason ?? null });
  }
  retry(id: string) {
    return this.request<MissionSummaryDTO>('POST', `/api/missions/${encodeURIComponent(id)}/retry`, {});
  }
  replan(id: string, refreshSource = false) {
    return this.request<MissionSummaryDTO>('POST', `/api/missions/${encodeURIComponent(id)}/replan`, { refreshSource });
  }
  complete(id: string) {
    return this.request<MissionSummaryDTO>('POST', `/api/missions/${encodeURIComponent(id)}/complete`, {});
  }
}

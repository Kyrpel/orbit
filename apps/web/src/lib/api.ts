import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  ActivityItem,
  AgentRoleDTO,
  ConversationDetailDTO,
  ConversationSummaryDTO,
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
  RepoChangesDTO,
  RepoDTO,
  Settings,
  SettingsPatch,
  TeamDTO,
  WorkspaceDTO,
} from '@orbit/shared';
import { toast } from './toast';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string | undefined;
  constructor(code: string, message: string, status: number, hint?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), 'X-Orbit-Client': 'dashboard', ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; hint?: string } } | undefined)?.error;
    throw new ApiError(e?.code ?? 'HTTP', e?.message ?? `Request failed (${res.status})`, res.status, e?.hint);
  }
  return data as T;
}

const send = <T>(method: string, path: string, body?: unknown) => api<T>(path, { method, body: JSON.stringify(body ?? {}) });
export const post = <T>(path: string, body?: unknown) => send<T>('POST', path, body);
export const patch = <T>(path: string, body?: unknown) => send<T>('PATCH', path, body);
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export const keys = {
  session: ['session'] as const,
  overview: ['overview'] as const,
  missions: (filter = 'all') => ['missions', filter] as const,
  mission: (id: string) => ['mission', id] as const,
  events: (id: string) => ['events', id] as const,
  diff: (id: string, mr: string) => ['diff', id, mr] as const,
  repos: ['repos'] as const,
  repo: (id: string) => ['repo', id] as const,
  projects: ['projects'] as const,
  projectTasks: (id: string) => ['project-tasks', id] as const,
  integrations: ['integrations'] as const,
  workspaces: (id: string) => ['workspaces', id] as const,
  remoteProjects: (id: string, ws: string) => ['remote-projects', id, ws] as const,
  settings: ['settings'] as const,
  doctor: ['doctor'] as const,
  agents: ['agents'] as const,
  team: ['team'] as const,
  chats: ['chats'] as const,
  chat: (id: string) => ['chat', id] as const,
  changes: (repoId: string) => ['changes', repoId] as const,
  activity: ['activity'] as const,
  github: ['github-repos'] as const,
  receipt: (id: string) => ['receipt', id] as const,
};

export function useSession() {
  return useQuery({ queryKey: keys.session, queryFn: () => api<{ ok: boolean; version: string; dashboardUrl: string; home: string }>('/api/session'), retry: false, staleTime: 60_000 });
}
export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => api<OverviewDTO>('/api/overview'), refetchInterval: 60_000 });
export const useMissions = (filter: 'all' | 'attention' | 'active' | 'done' = 'all') =>
  useQuery({
    queryKey: keys.missions(filter),
    queryFn: () =>
      api<MissionSummaryDTO[]>(
        `/api/missions${filter === 'attention' ? '?attention=true' : filter === 'active' ? '?active=true' : filter === 'done' ? '?status=PR_CREATED,COMPLETED,CANCELLED' : ''}`,
      ),
  });
export const useMission = (id: string) => useQuery({ queryKey: keys.mission(id), queryFn: () => api<MissionDetailDTO>(`/api/missions/${id}`) });
export const useMissionEvents = (id: string) => useQuery({ queryKey: keys.events(id), queryFn: () => api<MissionEventDTO[]>(`/api/missions/${id}/events?limit=2000`) });
export const useDiff = (id: string, missionRepoId: string | null, version: string) =>
  useQuery({
    queryKey: [...keys.diff(id, missionRepoId ?? 'none'), version],
    queryFn: () => api<{ diff: string; truncated: boolean; stats: DiffStats | null }>(`/api/missions/${id}/diff?missionRepoId=${missionRepoId}`),
    enabled: !!missionRepoId,
  });
export const useRepos = () => useQuery({ queryKey: keys.repos, queryFn: () => api<RepoDTO[]>('/api/repos') });
export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => api<ExternalProjectDTO[]>('/api/projects') });
export const useProjectTasks = (id: string | null) =>
  useQuery({ queryKey: keys.projectTasks(id ?? 'none'), queryFn: () => api<ExternalTaskDTO[]>(`/api/projects/${id}/tasks`), enabled: !!id, staleTime: 30_000 });
export const useIntegrations = () => useQuery({ queryKey: keys.integrations, queryFn: () => api<IntegrationDTO[]>('/api/integrations') });
export const useWorkspaces = (integrationId: string | null) =>
  useQuery({ queryKey: keys.workspaces(integrationId ?? 'none'), queryFn: () => api<WorkspaceDTO[]>(`/api/integrations/${integrationId}/workspaces`), enabled: !!integrationId });
export const useRemoteProjects = (integrationId: string | null, workspaceId: string | null) =>
  useQuery({
    queryKey: keys.remoteProjects(integrationId ?? 'none', workspaceId ?? 'none'),
    queryFn: () => api<{ id: string; name: string; url: string | null; connectedProjectId: string | null }[]>(`/api/integrations/${integrationId}/projects?workspace=${workspaceId}`),
    enabled: !!integrationId && !!workspaceId,
  });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => api<Settings>('/api/settings') });
export const useDoctor = () => useQuery({ queryKey: keys.doctor, queryFn: () => api<DoctorReport>('/api/doctor'), staleTime: 30_000 });
export const useAgents = () => useQuery({ queryKey: keys.agents, queryFn: () => api<AgentRoleDTO[]>('/api/agents') });
export const useTeam = () => useQuery({ queryKey: keys.team, queryFn: () => api<TeamDTO>('/api/team'), staleTime: 30_000 });
export const useChats = () => useQuery({ queryKey: keys.chats, queryFn: () => api<ConversationSummaryDTO[]>('/api/chats') });
export const useChanges = (repoId: string | null, enabled = true) =>
  useQuery({ queryKey: keys.changes(repoId ?? 'none'), queryFn: () => api<RepoChangesDTO>(`/api/repos/${repoId}/changes`), enabled: !!repoId && enabled, staleTime: 2_000 });
export const useChat = (id: string | null) => useQuery({ queryKey: keys.chat(id ?? 'none'), queryFn: () => api<ConversationDetailDTO>(`/api/chats/${id}`), enabled: !!id });
export const useActivity = () => useQuery({ queryKey: keys.activity, queryFn: () => api<ActivityItem[]>('/api/activity?limit=200') });
export const useReceipt = (id: string, enabled: boolean) => useQuery({ queryKey: keys.receipt(id), queryFn: () => api<ReceiptDTO>(`/api/missions/${id}/receipt`), enabled });

/** Mutation helper: runs `fn`, toasts the outcome, and invalidates the given query keys. */
export function useAction<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>, opts: { success?: string | ((r: TResult) => string); invalidate?: QueryKey[] } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const k of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: k });
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
    },
    onError: (err) => {
      const e = err as ApiError;
      toast.error(e.message, e.hint);
    },
  });
}

export type { SettingsPatch };

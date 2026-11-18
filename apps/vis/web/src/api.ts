import type {
  SessionSummary,
  SessionDetail,
  DeleteSessionResponse,
  WireResponse,
  ContextResponse,
  AgentTreeResponse,
  BackgroundTasksResponse,
  TaskOutputResponse,
  CronTasksResponse,
  ImportResult,
  LogsResponse,
  ApiError,
} from './types';

const TOKEN_STORAGE_KEY = 'kimi-vis-auth-token';

function readTokenParam(raw: string): string | null {
  const trimmed = raw.replace(/^[#?]/, '');
  if (trimmed.length === 0) return null;
  const params = new URLSearchParams(trimmed);
  return params.get('token') ?? params.get('vis_token');
}

function deleteTokenParams(params: URLSearchParams): boolean {
  const hadToken = params.has('token') || params.has('vis_token');
  params.delete('token');
  params.delete('vis_token');
  return hadToken;
}

function scrubTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const changedSearch = deleteTokenParams(url.searchParams);
  const hash = url.hash.replace(/^#/, '');
  let changedHash = false;
  if (hash.length > 0) {
    const hashParams = new URLSearchParams(hash);
    changedHash = deleteTokenParams(hashParams);
    if (changedHash) {
      const nextHash = hashParams.toString();
      url.hash = nextHash.length > 0 ? nextHash : '';
    }
  }
  if (changedSearch || changedHash) {
    window.history.replaceState(null, '', url.toString());
  }
}

function authToken(): string | null {
  if (typeof window === 'undefined') return null;
  const fromHash = readTokenParam(window.location.hash);
  const fromSearch = readTokenParam(window.location.search);
  const token = fromHash ?? fromSearch;
  if (token !== null && token.length > 0) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    scrubTokenFromUrl();
    return token;
  }
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

async function request<T>(path: string, method: 'GET' | 'POST' | 'DELETE'): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = authToken();
  if (token !== null && token.length > 0) {
    headers['authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(path, { method, headers });
  if (!res.ok) {
    let err: ApiError | null = null;
    try {
      err = (await res.json()) as ApiError;
    } catch {}
    throw new Error(err?.error ?? `HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, 'GET');
}

function post<T>(path: string): Promise<T> {
  return request<T>(path, 'POST');
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, 'DELETE');
}

const enc = encodeURIComponent;

interface SessionsListResponse {
  sessions: SessionSummary[];
}

export const api = {
  listSessions: async (): Promise<SessionSummary[]> => {
    const r = await get<SessionsListResponse>('/api/sessions');
    return r.sessions;
  },

  getSession: (id: string) => get<SessionDetail>(`/api/sessions/${enc(id)}`),

  getWire: (id: string, agentId: string) =>
    get<WireResponse>(`/api/sessions/${enc(id)}/wire?agent=${enc(agentId)}`),

  getContext: (id: string, agentId: string, mode?: 'model' | 'full') =>
    get<ContextResponse>(
      `/api/sessions/${enc(id)}/context?agent=${enc(agentId)}` +
        (mode === 'full' ? '&history=full' : ''),
    ),

  getAgentTree: (id: string) =>
    get<AgentTreeResponse>(`/api/sessions/${enc(id)}/agents`),

  getTasks: (id: string) =>
    get<BackgroundTasksResponse>(`/api/sessions/${enc(id)}/tasks`),

  getTaskOutput: (id: string, taskId: string, offset = 0, limit?: number) =>
    get<TaskOutputResponse>(
      `/api/sessions/${enc(id)}/tasks/${enc(taskId)}/output?offset=${offset}` +
        (limit !== undefined ? `&limit=${limit}` : ''),
    ),

  getCron: (id: string) =>
    get<CronTasksResponse>(`/api/sessions/${enc(id)}/cron`),

  getLogs: (id: string, which: 'session' | 'global' = 'session') =>
    get<LogsResponse>(`/api/sessions/${enc(id)}/logs?which=${which}`),

  importZip: async (file: File): Promise<ImportResult> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = authToken();
    if (token !== null && token.length > 0) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`/api/imports?name=${enc(file.name)}`, {
      method: 'POST',
      headers,
      body: file,
    });
    if (!res.ok) {
      let err: ApiError | null = null;
      try {
        err = (await res.json()) as ApiError;
      } catch {}
      throw new Error(err?.error ?? `HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as ImportResult;
  },

  deleteSession: (id: string) => del<DeleteSessionResponse>(`/api/sessions/${enc(id)}`),

  revealSession: (id: string) =>
    post<{ sessionId: string; opened: string }>(`/api/sessions/${enc(id)}/reveal`),
};

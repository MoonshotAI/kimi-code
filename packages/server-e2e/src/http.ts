/**
 * HTTP layer for `DaemonClient` — typed wrappers around fetch + envelope
 * unwrap. All paths concatenate `baseUrl + apiPrefix + route`.
 */
import type {
  ApprovalResolveResult,
  ApprovalResponse,
  AuthSummary,
  CloseTerminalResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  CreateTerminalRequest,
  Envelope,
  FileMeta,
  ForkSessionRequest,
  FsBrowseResponse,
  FsHomeResponse,
  ListTerminalsResponse,
  ListModelsResponse,
  ListPendingApprovalsResponse,
  ListPendingQuestionsResponse,
  ListProvidersResponse,
  Message,
  ProviderCatalogItem,
  PromptAbortResponse,
  PromptListResponse,
  PromptSubmission,
  PromptSteerResult,
  PromptSubmitResult,
  QuestionResolveResult,
  QuestionResponse,
  SessionAbortResponse,
  SetDefaultModelResponse,
  Session,
  SessionChildCreate,
  SessionCreate,
  SessionUpdate,
  UndoSessionRequest,
  UndoSessionResponse,
  Terminal,
  Workspace,
  WorkspaceCreate,
  WorkspaceUpdate,
} from '@moonshot-ai/protocol';

import { unwrap } from './envelope.js';
import { fetchWithReport, recordReportEvent } from './report.js';

export interface HttpClientOptions {
  baseUrl: string;
  apiPrefix: string;
  fetchImpl: typeof fetch;
  reportDir?: string;
}

type UploadFileData = Blob | ArrayBuffer | Uint8Array | string;

export class HttpClient {
  constructor(private readonly opts: HttpClientOptions) {}

  private url(path: string): string {
    return `${this.opts.baseUrl}${this.opts.apiPrefix}${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
  ): Promise<T> {
    const startedAt = Date.now();
    const headers: Record<string, string> = { accept: 'application/json' };
    let init: RequestInit;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init = { method, headers, body: JSON.stringify(body) };
    } else {
      init = { method, headers };
    }
    const url = this.url(path);
    let res: Response;
    let text = '';
    try {
      res = await this.opts.fetchImpl(url, init);
      text = await res.text();
    } catch (error) {
      recordReportEvent(
        {
          kind: 'http',
          method,
          path,
          url,
          durationMs: Date.now() - startedAt,
          request: requestForReport(body),
          error: errorForReport(error),
        },
        { reportDir: this.opts.reportDir },
      );
      throw error;
    }
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch (error) {
      recordReportEvent(
        {
          kind: 'http',
          method,
          path,
          url,
          status: res.status,
          durationMs: Date.now() - startedAt,
          request: requestForReport(body),
          response: { raw: text.slice(0, 2_000) },
          error: errorForReport(error),
        },
        { reportDir: this.opts.reportDir },
      );
      throw new Error(
        `server ${method} ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
        { cause: error },
      );
    }
    recordReportEvent(
      {
        kind: 'http',
        method,
        path,
        url,
        status: res.status,
        durationMs: Date.now() - startedAt,
        request: requestForReport(body),
        response: { envelope },
      },
      { reportDir: this.opts.reportDir },
    );
    return unwrap(envelope);
  }

  private async formRequest<T>(
    method: 'POST',
    path: string,
    body: FormData,
  ): Promise<T> {
    const url = this.url(path);
    const res = await fetchWithReport(
      url,
      {
        method,
        headers: { accept: 'application/json' },
        body,
      },
      {
        fetchImpl: this.opts.fetchImpl,
        reportDir: this.opts.reportDir,
        path,
      },
    );
    const text = await res.text();
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch (error) {
      throw new Error(
        `server ${method} ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
        { cause: error },
      );
    }
    return unwrap(envelope);
  }

  // ── Probes + model catalog ─────────────────────────────────────────────
  getAuth(): Promise<AuthSummary> {
    return this.request<AuthSummary>('GET', '/auth', undefined);
  }
  listModels(): Promise<ListModelsResponse> {
    return this.request('GET', '/models', undefined);
  }
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    return this.request(
      'POST',
      `/models/${encodeURIComponent(modelId)}:set_default`,
      {},
    );
  }
  listProviders(): Promise<ListProvidersResponse> {
    return this.request('GET', '/providers', undefined);
  }
  getProvider(providerId: string): Promise<ProviderCatalogItem> {
    return this.request(
      'GET',
      `/providers/${encodeURIComponent(providerId)}`,
      undefined,
    );
  }

  // ── Sessions ────────────────────────────────────────────────────────────
  createSession(body: SessionCreate): Promise<Session> {
    return this.request<Session>('POST', '/sessions', body);
  }
  getSession(sid: string): Promise<Session> {
    return this.request<Session>('GET', `/sessions/${encodeURIComponent(sid)}`, undefined);
  }
  listSessions(query?: {
    page_size?: number;
    before_id?: string;
    after_id?: string;
    workspace_id?: string;
  }): Promise<{ items: Session[]; has_more: boolean }> {
    return this.request('GET', `/sessions${qs(query)}`, undefined);
  }
  updateSession(sid: string, body: SessionUpdate): Promise<Session> {
    // Daemon canonical route: `POST /v1/sessions/{sid}/profile` (REST.md §3.3).
    // Earlier scaffolding spoke `PATCH /v1/sessions/{sid}`, which the server
    // never wired — keep the helper name (used by existing fixtures) and just
    // dispatch to the right URL.
    return this.request<Session>(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/profile`,
      body,
    );
  }
  forkSession(sid: string, body: ForkSessionRequest = {}): Promise<Session> {
    return this.request('POST', `/sessions/${encodeURIComponent(sid)}:fork`, body);
  }
  compactSession(
    sid: string,
    body: CompactSessionRequest = {},
  ): Promise<CompactSessionResponse> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}:compact`,
      body,
    );
  }
  undoSession(
    sid: string,
    body: UndoSessionRequest = { count: 1 },
  ): Promise<UndoSessionResponse> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}:undo`,
      body,
    );
  }
  archiveSession(sid: string): Promise<{ archived: true }> {
    return this.request('POST', `/sessions/${encodeURIComponent(sid)}:archive`, {});
  }
  listChildren(
    sid: string,
    query?: { page_size?: number; before_id?: string; after_id?: string; status?: Session['status'] },
  ): Promise<{ items: Session[]; has_more: boolean }> {
    return this.request(
      'GET',
      `/sessions/${encodeURIComponent(sid)}/children${qs(query)}`,
      undefined,
    );
  }
  createChild(sid: string, body: SessionChildCreate = {}): Promise<Session> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/children`,
      body,
    );
  }

  // ── Terminals ──────────────────────────────────────────────────────────
  listTerminals(sid: string): Promise<ListTerminalsResponse> {
    return this.request(
      'GET',
      `/sessions/${encodeURIComponent(sid)}/terminals`,
      undefined,
    );
  }
  createTerminal(
    sid: string,
    body: CreateTerminalRequest = {},
  ): Promise<Terminal> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/terminals`,
      body,
    );
  }
  getTerminal(sid: string, terminalId: string): Promise<Terminal> {
    return this.request(
      'GET',
      `/sessions/${encodeURIComponent(sid)}/terminals/${encodeURIComponent(terminalId)}`,
      undefined,
    );
  }
  closeTerminal(
    sid: string,
    terminalId: string,
  ): Promise<CloseTerminalResponse> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/terminals/${encodeURIComponent(terminalId)}:close`,
      {},
    );
  }

  // ── Workspaces ──────────────────────────────────────────────────────────
  listWorkspaces(): Promise<{ items: Workspace[] }> {
    return this.request('GET', '/workspaces', undefined);
  }
  createWorkspace(body: WorkspaceCreate): Promise<Workspace> {
    return this.request<Workspace>('POST', '/workspaces', body);
  }
  updateWorkspace(workspaceId: string, body: WorkspaceUpdate): Promise<Workspace> {
    return this.request<Workspace>(
      'PATCH',
      `/workspaces/${encodeURIComponent(workspaceId)}`,
      body,
    );
  }
  deleteWorkspace(workspaceId: string): Promise<{ deleted: true }> {
    return this.request(
      'DELETE',
      `/workspaces/${encodeURIComponent(workspaceId)}`,
      undefined,
    );
  }

  // ── Folder picker (fs:browse + fs:home) ─────────────────────────────────
  fsBrowse(path?: string): Promise<FsBrowseResponse> {
    return this.request('GET', `/fs:browse${qs({ path })}`, undefined);
  }
  fsHome(): Promise<FsHomeResponse> {
    return this.request('GET', '/fs:home', undefined);
  }

  // ── Uploads ─────────────────────────────────────────────────────────────
  uploadFile(input: {
    name: string;
    data: UploadFileData;
    mediaType?: string;
    expiresInSec?: number;
  }): Promise<FileMeta> {
    const form = new FormData();
    form.append('name', input.name);
    if (input.expiresInSec !== undefined) {
      form.append('expires_in_sec', String(input.expiresInSec));
    }
    form.append('file', blobFromInput(input), input.name);
    return this.formRequest<FileMeta>('POST', '/files', form);
  }
  deleteFile(fileId: string): Promise<{ deleted: true }> {
    return this.request('DELETE', `/files/${encodeURIComponent(fileId)}`, undefined);
  }

  // ── Messages ────────────────────────────────────────────────────────────
  listMessages(
    sid: string,
    query?: { page_size?: number; before_id?: string; after_id?: string; role?: string },
  ): Promise<{ items: Message[]; has_more: boolean }> {
    return this.request('GET', `/sessions/${encodeURIComponent(sid)}/messages${qs(query)}`, undefined);
  }

  // ── Prompts ─────────────────────────────────────────────────────────────
  listPrompts(sid: string): Promise<PromptListResponse> {
    return this.request('GET', `/sessions/${encodeURIComponent(sid)}/prompts`, undefined);
  }
  submitPrompt(sid: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    return this.request('POST', `/sessions/${encodeURIComponent(sid)}/prompts`, body);
  }
  steerPrompt(sid: string, pid: string): Promise<PromptSteerResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/prompts/${encodeURIComponent(pid)}:steer`,
      {},
    );
  }
  steerPrompts(sid: string, promptIds: readonly string[]): Promise<PromptSteerResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/prompts:steer`,
      { prompt_ids: [...promptIds] },
    );
  }
  abortPrompt(sid: string, pid: string): Promise<PromptAbortResponse> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/prompts/${encodeURIComponent(pid)}:abort`,
      {},
    );
  }
  abortSession(sid: string): Promise<SessionAbortResponse> {
    return this.request('POST', `/sessions/${encodeURIComponent(sid)}:abort`, {});
  }

  // ── Approvals / Questions (reverse-RPC resolves) ────────────────────────
  resolveApproval(
    sid: string,
    aid: string,
    body: ApprovalResponse,
  ): Promise<ApprovalResolveResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/approvals/${encodeURIComponent(aid)}`,
      body,
    );
  }
  listPendingApprovals(sid: string): Promise<ListPendingApprovalsResponse> {
    return this.request(
      'GET',
      `/sessions/${encodeURIComponent(sid)}/approvals?status=pending`,
      undefined,
    );
  }
  resolveQuestion(
    sid: string,
    qid: string,
    body: QuestionResponse,
  ): Promise<QuestionResolveResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/questions/${encodeURIComponent(qid)}`,
      body,
    );
  }
  listPendingQuestions(sid: string): Promise<ListPendingQuestionsResponse> {
    return this.request(
      'GET',
      `/sessions/${encodeURIComponent(sid)}/questions?status=pending`,
      undefined,
    );
  }
  dismissQuestion(
    sid: string,
    qid: string,
  ): Promise<{ dismissed: true; dismissed_at: string }> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/questions/${encodeURIComponent(qid)}:dismiss`,
      {},
    );
  }
}

function requestForReport(body: unknown): { body?: unknown } {
  return body === undefined ? {} : { body };
}

function errorForReport(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return error;
}

function qs(query: Record<string, string | number | boolean | undefined> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(serializedQueryValue(v))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

function serializedQueryValue(value: string | number | boolean): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  return value ? 'true' : 'false';
}

function blobFromInput(input: {
  data: UploadFileData;
  mediaType?: string;
}): Blob {
  if (input.data instanceof Blob) return input.data;
  return new Blob([input.data], {
    type: input.mediaType ?? 'application/octet-stream',
  });
}

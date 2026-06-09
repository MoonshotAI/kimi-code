// apps/kimi-web/src/api/daemon/client.ts
// DaemonKimiWebApi — implements KimiWebApi using the daemon REST + WS APIs.

import type { KimiApiConfig } from '../config';
import { buildWsUrl } from '../config';
import type {
  AppMessage,
  AppMessageRole,
  AppModel,
  AppProvider,
  AppSession,
  AppSessionStatus,
  AppTask,
  AppTaskStatus,
  AppWorkspace,
  ApprovalResponse,
  FsBrowseResult,
  FsEntry,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  Page,
  PageRequest,
  PromptSubmission,
  PromptSubmitResult,
  QuestionResponse,
} from '../types';
import { createAgentProjector } from './agentEventProjector';
import { DaemonHttpClient } from './http';
import {
  toAppEvent,
  toAppFsEntry,
  toAppMessage,
  toAppModel,
  toAppProvider,
  toAppSession,
  toAppTask,
  toWireApprovalResponse,
  toWirePromptSubmission,
  toWireQuestionResponse,
  toWireSessionStatus,
  toAppWorkspace,
  wireEventSeq,
  wireEventSessionId,
} from './mappers';
import type {
  WireAuthResult,
  WireBackgroundTask,
  WireEvent,
  WireFileMeta,
  WireFsBrowseResult,
  WireFsEntry,
  WireFsHomeResult,
  WireMessage,
  WireModel,
  WireOAuthCancelResult,
  WireOAuthLoginPollResult,
  WireOAuthLoginStartResult,
  WirePage,
  WirePromptSubmitResult,
  WireProvider,
  WireSession,
  WireWorkspace,
  WireLogoutResult,
} from './wire';
import { DaemonEventSocket } from './ws';

// ---------------------------------------------------------------------------
// Wire response shapes for endpoints not in shared wire.ts
// ---------------------------------------------------------------------------

interface WireHealth {
  status: 'ok';
  uptime_sec: number;
}

interface WireMeta {
  daemon_version: string;
  server_id: string;
  started_at: string;
  capabilities: Record<string, boolean>;
}

interface WireAbortResult {
  aborted: boolean;
  at_seq?: number;
}

interface WireDismissResult {
  dismissed: boolean;
  dismissed_at: string;
}

interface WireApprovalResolveResult {
  resolved: true;
  resolved_at: string;
}

interface WireQuestionResolveResult {
  resolved: true;
  resolved_at: string;
}

interface WireCancelResult {
  cancelled: true;
}

interface WireDeleteResult {
  deleted: true;
}

interface WireListDirectoryResult {
  items: WireFsEntry[];
  children_by_path?: Record<string, WireFsEntry[]>;
  truncated: boolean;
}

interface WireReadFileResult {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
  truncated: boolean;
  etag: string;
  mime: string;
  language_id?: string;
  line_count?: number;
  is_binary: boolean;
}

interface WireSearchFilesResult {
  items: Array<{
    path: string;
    name: string;
    kind: 'file' | 'directory' | 'symlink';
    score: number;
    match_positions: number[];
  }>;
  truncated: boolean;
}

interface WireGrepFilesResult {
  files: Array<{
    path: string;
    matches: Array<{
      line: number;
      col: number;
      text: string;
      before: string[];
      after: string[];
    }>;
  }>;
  files_scanned: number;
  truncated: boolean;
  elapsed_ms: number;
}

interface WireGitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, string>;
}

interface WireDiffResult {
  path: string;
  diff: string;
}

// ---------------------------------------------------------------------------
// DaemonKimiWebApi
// ---------------------------------------------------------------------------

export class DaemonKimiWebApi implements KimiWebApi {
  private readonly http: DaemonHttpClient;
  private readonly config: KimiApiConfig;

  constructor(config: KimiApiConfig) {
    this.config = config;
    this.http = new DaemonHttpClient(config.daemonHttpUrl);
  }

  // -------------------------------------------------------------------------
  // Health / Meta
  // -------------------------------------------------------------------------

  async getHealth(): Promise<{ status: 'ok'; uptimeSec: number }> {
    // Real daemon returns { ok: true }; the older shape was { status, uptime_sec }.
    const data = await this.http.get<Partial<WireHealth>>('/healthz');
    return { status: 'ok', uptimeSec: data.uptime_sec ?? 0 };
  }

  async getMeta(): Promise<{
    daemonVersion: string;
    serverId: string;
    startedAt: string;
    capabilities: Record<string, boolean>;
  }> {
    const data = await this.http.get<WireMeta>('/meta');
    return {
      daemonVersion: data.daemon_version,
      serverId: data.server_id,
      startedAt: data.started_at,
      capabilities: data.capabilities,
    };
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async listSessions(
    input?: PageRequest & { status?: AppSessionStatus; workspaceId?: string },
  ): Promise<Page<AppSession>> {
    const query: Record<string, string | number | boolean | undefined> = {
      before_id: input?.beforeId,
      after_id: input?.afterId,
      page_size: input?.pageSize,
      status: input?.status ? toWireSessionStatus(input.status) : undefined,
      // PRESUMED — daemon supports ?workspace_id= once the registry ships; it
      // ignores unknown query params until then, so this is safe to always send.
      workspace_id: input?.workspaceId,
    };
    const data = await this.http.get<WirePage<WireSession>>('/sessions', query);
    return {
      items: data.items.map(toAppSession),
      hasMore: data.has_more,
    };
  }

  async createSession(input: {
    title?: string;
    cwd?: string;
    model?: string;
    workspaceId?: string;
  }): Promise<AppSession> {
    // The real daemon requires `metadata` to be an object (rejects a missing
    // metadata with 40001), so always send it — with cwd when provided.
    const body: Record<string, unknown> = {
      metadata: input.cwd !== undefined ? { cwd: input.cwd } : {},
    };
    // PRESUMED — daemon resolves cwd from workspace_id once the registry ships.
    // We ALSO send metadata.cwd (above) as the fallback so today's daemon, which
    // only understands cwd, still creates the session in the right folder.
    if (input.workspaceId !== undefined) body['workspace_id'] = input.workspaceId;
    if (input.title !== undefined) body['title'] = input.title;
    if (input.model !== undefined) body['agent_config'] = { model: input.model };
    const data = await this.http.post<WireSession>('/sessions', body);
    return toAppSession(data);
  }

  async updateSession(
    sessionId: string,
    input: { title?: string; cwd?: string; model?: string },
  ): Promise<AppSession> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body['title'] = input.title;
    if (input.cwd !== undefined) body['metadata'] = { cwd: input.cwd };
    if (input.model !== undefined) body['agent_config'] = { model: input.model };
    const data = await this.http.patch<WireSession>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      body,
    );
    return toAppSession(data);
  }

  async deleteSession(sessionId: string): Promise<{ deleted: true }> {
    const data = await this.http.delete<WireDeleteResult>(
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    return data;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async listMessages(
    sessionId: string,
    input?: PageRequest & { role?: AppMessageRole },
  ): Promise<Page<AppMessage>> {
    const query: Record<string, string | number | boolean | undefined> = {
      before_id: input?.beforeId,
      after_id: input?.afterId,
      page_size: input?.pageSize,
      role: input?.role,
    };
    const data = await this.http.get<WirePage<WireMessage>>(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      query,
    );
    return {
      items: data.items.map(toAppMessage),
      hasMore: data.has_more,
    };
  }

  // -------------------------------------------------------------------------
  // Prompt
  // -------------------------------------------------------------------------

  async submitPrompt(
    sessionId: string,
    input: PromptSubmission,
  ): Promise<PromptSubmitResult> {
    const data = await this.http.post<WirePromptSubmitResult>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts`,
      toWirePromptSubmission(input),
    );
    return {
      promptId: data.prompt_id,
      userMessageId: data.user_message_id,
    };
  }

  async abortPrompt(
    sessionId: string,
    promptId: string,
  ): Promise<{ aborted: boolean; atSeq?: number }> {
    const data = await this.http.post<WireAbortResult>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
      undefined,
      { allowCodes: [40903] },
    );
    // data.aborted is false when 40903 (prompt already completed) — that's correct
    return { aborted: data.aborted, atSeq: data.at_seq };
  }

  // -------------------------------------------------------------------------
  // Approval / Question
  // -------------------------------------------------------------------------

  async respondApproval(
    sessionId: string,
    approvalId: string,
    response: ApprovalResponse,
  ): Promise<{ resolved: true; resolvedAt: string }> {
    const data = await this.http.post<WireApprovalResolveResult>(
      `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      toWireApprovalResponse(response),
    );
    return { resolved: data.resolved, resolvedAt: data.resolved_at };
  }

  async respondQuestion(
    sessionId: string,
    questionId: string,
    response: QuestionResponse,
  ): Promise<{ resolved: true; resolvedAt: string }> {
    const data = await this.http.post<WireQuestionResolveResult>(
      `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`,
      toWireQuestionResponse(response),
    );
    return { resolved: data.resolved, resolvedAt: data.resolved_at };
  }

  async dismissQuestion(
    sessionId: string,
    questionId: string,
  ): Promise<{ dismissed: true; dismissedAt: string }> {
    const data = await this.http.post<WireDismissResult>(
      `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}:dismiss`,
      undefined,
      { allowCodes: [40909] },
    );
    // 40909 means question.dismissed — that's the success path per spec
    return { dismissed: true, dismissedAt: data.dismissed_at };
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  async listTasks(sessionId: string, status?: AppTaskStatus): Promise<AppTask[]> {
    const query: Record<string, string | undefined> = {
      status: status,
    };
    const data = await this.http.get<{ items: WireBackgroundTask[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/tasks`,
      query,
    );
    return data.items.map(toAppTask);
  }

  async getTask(
    sessionId: string,
    taskId: string,
    input?: { withOutput?: boolean; outputBytes?: number },
  ): Promise<AppTask> {
    const query: Record<string, string | number | boolean | undefined> = {
      with_output: input?.withOutput,
      output_bytes: input?.outputBytes,
    };
    const data = await this.http.get<WireBackgroundTask>(
      `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`,
      query,
    );
    return toAppTask(data);
  }

  async cancelTask(sessionId: string, taskId: string): Promise<{ cancelled: true }> {
    const data = await this.http.post<WireCancelResult>(
      `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}:cancel`,
    );
    return data;
  }

  // -------------------------------------------------------------------------
  // File System
  // -------------------------------------------------------------------------

  async listDirectory(
    sessionId: string,
    input: { path?: string; depth?: number; includeGitStatus?: boolean },
  ): Promise<{
    items: FsEntry[];
    childrenByPath?: Record<string, FsEntry[]>;
    truncated: boolean;
  }> {
    const body: Record<string, unknown> = {};
    if (input.path !== undefined) body['path'] = input.path;
    if (input.depth !== undefined) body['depth'] = input.depth;
    if (input.includeGitStatus !== undefined) body['include_git_status'] = input.includeGitStatus;
    const data = await this.http.post<WireListDirectoryResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:list`,
      body,
    );
    const childrenByPath = data.children_by_path
      ? Object.fromEntries(
          Object.entries(data.children_by_path).map(([k, v]) => [k, v.map(toAppFsEntry)]),
        )
      : undefined;
    return {
      items: data.items.map(toAppFsEntry),
      childrenByPath,
      truncated: data.truncated,
    };
  }

  async readFile(
    sessionId: string,
    input: { path: string; offset?: number; length?: number },
  ): Promise<{
    path: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    size: number;
    truncated: boolean;
    etag: string;
    mime: string;
    languageId?: string;
    lineCount?: number;
    isBinary: boolean;
  }> {
    const body: Record<string, unknown> = { path: input.path };
    if (input.offset !== undefined) body['offset'] = input.offset;
    if (input.length !== undefined) body['length'] = input.length;
    const data = await this.http.post<WireReadFileResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:read`,
      body,
    );
    return {
      path: data.path,
      content: data.content,
      encoding: data.encoding,
      size: data.size,
      truncated: data.truncated,
      etag: data.etag,
      mime: data.mime,
      languageId: data.language_id,
      lineCount: data.line_count,
      isBinary: data.is_binary,
    };
  }

  async searchFiles(
    sessionId: string,
    input: { query: string; limit?: number },
  ): Promise<{
    items: Array<{
      path: string;
      name: string;
      kind: 'file' | 'directory' | 'symlink';
      score: number;
      matchPositions: number[];
    }>;
    truncated: boolean;
  }> {
    const body: Record<string, unknown> = { query: input.query };
    if (input.limit !== undefined) body['limit'] = input.limit;
    const data = await this.http.post<WireSearchFilesResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:search`,
      body,
    );
    return {
      items: data.items.map((item) => ({
        path: item.path,
        name: item.name,
        kind: item.kind,
        score: item.score,
        matchPositions: item.match_positions,
      })),
      truncated: data.truncated,
    };
  }

  async grepFiles(
    sessionId: string,
    input: { pattern: string; regex?: boolean; caseSensitive?: boolean },
  ): Promise<{
    files: Array<{
      path: string;
      matches: Array<{
        line: number;
        col: number;
        text: string;
        before: string[];
        after: string[];
      }>;
    }>;
    filesScanned: number;
    truncated: boolean;
    elapsedMs: number;
  }> {
    const body: Record<string, unknown> = { pattern: input.pattern };
    if (input.regex !== undefined) body['regex'] = input.regex;
    if (input.caseSensitive !== undefined) body['case_sensitive'] = input.caseSensitive;
    const data = await this.http.post<WireGrepFilesResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:grep`,
      body,
    );
    return {
      files: data.files,
      filesScanned: data.files_scanned,
      truncated: data.truncated,
      elapsedMs: data.elapsed_ms,
    };
  }

  async getGitStatus(
    sessionId: string,
    paths?: string[],
  ): Promise<{ branch: string; ahead: number; behind: number; entries: Record<string, string> }> {
    const body: Record<string, unknown> = {};
    if (paths !== undefined) body['paths'] = paths;
    const data = await this.http.post<WireGitStatusResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:git_status`,
      body,
    );
    return {
      branch: data.branch,
      ahead: data.ahead,
      behind: data.behind,
      entries: data.entries,
    };
  }

  async getFileDiff(
    sessionId: string,
    path?: string,
  ): Promise<{ path: string; diff: string }> {
    const body: Record<string, unknown> = {};
    if (path !== undefined) body['path'] = path;
    const data = await this.http.post<WireDiffResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:diff`,
      body,
    );
    return { path: data.path, diff: data.diff };
  }

  // -------------------------------------------------------------------------
  // Workspaces + daemon folder browser
  // PRESUMED — falls back until the daemon ships /workspaces, /fs:browse, /fs:home.
  // -------------------------------------------------------------------------

  /**
   * List the registered workspaces.
   * PRESUMED — GET /api/v1/workspaces. On 404/empty/error this returns [] and
   * the composable DERIVES workspaces from the current sessions' cwds. So the
   * switcher + grouping work immediately off existing sessions until the daemon
   * ships the registry.
   */
  async listWorkspaces(): Promise<AppWorkspace[]> {
    try {
      const data = await this.http.get<WirePage<WireWorkspace>>('/workspaces');
      return (data.items ?? []).map(toAppWorkspace);
    } catch {
      return [];
    }
  }

  /**
   * Register a workspace by folder path.
   * PRESUMED — POST /api/v1/workspaces { root, name? }. On error this throws so
   * the composable can fall back to a locally-derived workspace from the path.
   */
  async addWorkspace(input: { root: string; name?: string }): Promise<AppWorkspace> {
    const body: Record<string, unknown> = { root: input.root };
    if (input.name !== undefined) body['name'] = input.name;
    const data = await this.http.post<WireWorkspace>('/workspaces', body);
    return toAppWorkspace(data);
  }

  /**
   * Browse directories under `path` (defaults to $HOME on the daemon).
   * PRESUMED — GET /api/v1/fs:browse?path=. On error returns an empty result so
   * the picker degrades to paste-path + recentRoots.
   */
  async browseFs(path?: string): Promise<FsBrowseResult> {
    try {
      const data = await this.http.get<WireFsBrowseResult>('/fs:browse', { path });
      return {
        path: data.path,
        parent: data.parent,
        entries: (data.entries ?? []).map((e) => ({
          name: e.name,
          path: e.path,
          isDir: e.is_dir,
          isGitRepo: e.is_git_repo,
          branch: e.branch,
        })),
      };
    } catch {
      return { path: path ?? '', parent: null, entries: [] };
    }
  }

  /**
   * Get the picker start directory + recently-used roots.
   * PRESUMED — GET /api/v1/fs:home. On error returns empty defaults.
   */
  async getFsHome(): Promise<{ home: string; recentRoots: string[] }> {
    try {
      const data = await this.http.get<WireFsHomeResult>('/fs:home');
      return { home: data.home, recentRoots: data.recent_roots ?? [] };
    } catch {
      return { home: '', recentRoots: [] };
    }
  }

  // -------------------------------------------------------------------------
  // Models + Providers
  // PRESUMED — not in current daemon docs; isolated here, swap when backend defines them.
  // -------------------------------------------------------------------------

  async listModels(): Promise<AppModel[]> {
    // PRESUMED endpoint: GET /v1/models → { items: WireModel[] }
    const data = await this.http.get<{ items: WireModel[] }>('/models');
    return data.items.map(toAppModel);
  }

  async listProviders(): Promise<AppProvider[]> {
    // PRESUMED endpoint: GET /v1/providers → { items: WireProvider[] }
    const data = await this.http.get<{ items: WireProvider[] }>('/providers');
    return data.items.map(toAppProvider);
  }

  async addProvider(input: {
    type: string;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
  }): Promise<AppProvider> {
    // PRESUMED endpoint: POST /v1/providers → WireProvider
    const body: Record<string, unknown> = { type: input.type };
    if (input.apiKey !== undefined) body['api_key'] = input.apiKey;
    if (input.baseUrl !== undefined) body['base_url'] = input.baseUrl;
    if (input.defaultModel !== undefined) body['default_model'] = input.defaultModel;
    const data = await this.http.post<WireProvider>('/providers', body);
    return toAppProvider(data);
  }

  async deleteProvider(id: string): Promise<{ deleted: true }> {
    // PRESUMED endpoint: DELETE /v1/providers/{id} → { deleted: true }
    return this.http.delete<{ deleted: true }>(`/providers/${encodeURIComponent(id)}`);
  }

  async refreshProvider(id: string): Promise<AppProvider> {
    // PRESUMED endpoint: POST /v1/providers/{id}:refresh → WireProvider
    const data = await this.http.post<WireProvider>(
      `/providers/${encodeURIComponent(id)}:refresh`,
    );
    return toAppProvider(data);
  }

  // -------------------------------------------------------------------------
  // Auth — REAL endpoints
  // -------------------------------------------------------------------------

  async getAuth(): Promise<{
    ready: boolean;
    providersCount: number;
    defaultModel: string | null;
    managedProvider: { status: string } | null;
  }> {
    const data = await this.http.get<WireAuthResult>('/auth');
    return {
      ready: data.ready,
      providersCount: data.providers_count,
      defaultModel: data.default_model,
      managedProvider: data.managed_provider
        ? { status: data.managed_provider.status }
        : null,
    };
  }

  async startOAuthLogin(): Promise<{
    flowId: string;
    provider: string;
    verificationUri: string;
    verificationUriComplete: string;
    userCode: string;
    expiresIn: number;
    interval: number;
    status: 'pending';
    expiresAt: string;
  }> {
    const data = await this.http.post<WireOAuthLoginStartResult>('/oauth/login', {});
    return {
      flowId: data.flow_id,
      provider: data.provider,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      userCode: data.user_code,
      expiresIn: data.expires_in,
      interval: data.interval,
      status: data.status,
      expiresAt: data.expires_at,
    };
  }

  async pollOAuthLogin(): Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null> {
    // data may be null if no flow is active
    const data = await this.http.get<WireOAuthLoginPollResult | null>('/oauth/login');
    if (!data) return null;
    return {
      flowId: data.flow_id,
      status: data.status,
      resolvedAt: data.resolved_at,
    };
  }

  async cancelOAuthLogin(): Promise<{ cancelled: boolean; status: string }> {
    const data = await this.http.delete<WireOAuthCancelResult>('/oauth/login');
    return { cancelled: data.cancelled, status: data.status };
  }

  async logout(): Promise<{ loggedOut: boolean }> {
    const data = await this.http.post<WireLogoutResult>('/oauth/logout', {});
    return { loggedOut: data.logged_out };
  }

  // -------------------------------------------------------------------------
  // File upload
  // -------------------------------------------------------------------------

  async uploadFile(input: { file: Blob; name?: string }): Promise<{ id: string; name: string; mediaType: string; size: number }> {
    const formData = new FormData();
    formData.append('file', input.file, input.name ?? (input.file instanceof File ? input.file.name : 'upload'));
    if (input.name !== undefined) {
      formData.append('name', input.name);
    }
    const data = await this.http.postForm<WireFileMeta>('/files', formData);
    return {
      id: data.id,
      name: data.name,
      mediaType: data.media_type,
      size: data.size,
    };
  }

  // -------------------------------------------------------------------------
  // WebSocket events
  // -------------------------------------------------------------------------

  connectEvents(handlers: KimiEventHandlers): KimiEventConnection {
    const wsUrl = buildWsUrl(this.config.daemonHttpUrl, this.config.clientId);

    // Per-session projector for raw agent-core events.
    // Keyed by session_id; reset when a session is re-subscribed or resynced.
    const projector = createAgentProjector();

    const socket = new DaemonEventSocket(wsUrl, this.config.clientId, {
      // -----------------------------------------------------------------------
      // Projected "event.*" frames — existing path (kept working for stub / spec)
      // -----------------------------------------------------------------------
      onWireEvent: (wireEvent: WireEvent) => {
        const sessionId = wireEventSessionId(wireEvent);
        const seq = wireEventSeq(wireEvent);
        const appEvent = toAppEvent(wireEvent);

        // Route history_compacted to onResync so client can reload messages
        if (appEvent.type === 'historyCompacted') {
          handlers.onResync(appEvent.sessionId, appEvent.beforeSeq);
          // Still dispatch the event to onEvent so the reducer can update lastSeqBySession
        }

        // Deliver the AppEvent together with wire-level seq/session so the
        // reducer can advance lastSeqBySession[sessionId] = seq.
        handlers.onEvent(appEvent, { sessionId, seq });
      },

      // -----------------------------------------------------------------------
      // Raw agent-core frames — client-side projection path (real daemon)
      // -----------------------------------------------------------------------
      onRawAgentEvent: (frame) => {
        const { type, seq, session_id: sessionId, payload } = frame;
        const appEvents = projector.project(type, payload, sessionId);
        for (const appEvent of appEvents) {
          // Auto-compaction: the projector can't see the wire seq, so it emits
          // historyCompacted with beforeSeq:0. Route it to onResync using the
          // real frame.seq to reload /messages, mirroring the protocol path.
          if (appEvent.type === 'historyCompacted') {
            handlers.onResync(sessionId, seq);
          }
          handlers.onEvent(appEvent, { sessionId, seq });
        }
      },

      onResync: (sessionId: string, currentSeq: number) => {
        // Reset per-session projector state on resync
        projector.reset(sessionId);
        handlers.onResync(sessionId, currentSeq);
      },

      onConnectionState: (connected: boolean) => {
        handlers.onConnectionChange(connected);
      },

      onError: (code: number, msg: string, fatal: boolean) => {
        handlers.onError(code, msg, fatal);
      },
    });

    socket.connect();

    return {
      subscribe(sessionId: string, lastSeq?: number): void {
        // Reset projector state when (re-)subscribing a session
        projector.reset(sessionId);
        socket.subscribe(sessionId, lastSeq ?? 0);
      },
      unsubscribe(sessionId: string): void {
        socket.unsubscribe(sessionId);
      },
      bindNextPromptId(sessionId: string, promptId: string): void {
        // Wire the real daemon prompt_id into the projector so turn.started
        // uses it instead of a synthetic ulid('pr_'). Without this, the
        // synthetic id propagates to session.currentPromptId and the REST
        // :abort endpoint never matches the daemon's real prompt_id.
        projector.bindNextPromptId(sessionId, promptId);
      },
      abort(sessionId: string, promptId: string): void {
        socket.abort(sessionId, promptId);
      },
      close(): void {
        socket.close();
      },
    };
  }
}

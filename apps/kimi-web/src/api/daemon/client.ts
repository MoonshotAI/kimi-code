// apps/kimi-web/src/api/daemon/client.ts
// DaemonKimiWebApi — implements KimiWebApi using the daemon REST + WS APIs.

import type { KimiApiConfig } from '../config';
import { buildRestUrl, buildWsUrl } from '../config';
import { traceKeyEvent } from '../../debug/trace';
import type {
  AppConfig,
  AppGoal,
  AppMessage,
  AppMessageRole,
  AppModel,
  AppProvider,
  ProviderRefreshResult,
  AppSession,
  AppSkill,
  AppSessionCursor,
  AppSessionRuntimeStatus,
  AppSessionSnapshot,
  AppTask,
  AppTaskStatus,
  AppTerminal,
  AppWorkspace,
  ApprovalResponse,
  FsBrowseResult,
  FsEntry,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  OAuthLoginStartResult,
  Page,
  PageRequest,
  PromptSubmission,
  PromptSubmitResult,
  QuestionResponse,
} from '../types';
import { createAgentProjector } from './agentEventProjector';
import { DaemonHttpClient } from './http';
import {
  toAppApprovalRequest,
  toAppConfig,
  toAppEvent,
  toAppFsEntry,
  toAppGoal,
  toAppMessage,
  toAppModel,
  toAppProvider,
  toAppQuestionRequest,
  toAppSession,
  toAppTask,
  toWireApprovalResponse,
  toWirePromptSubmission,
  toWireQuestionResponse,
  toAppWorkspace,
  wireEventSeq,
  wireEventSessionId,
} from './mappers';
import type {
  WireAuthResult,
  WireTask,
  WireConfig,
  WireEvent,
  WireFileMeta,
  WireFsBrowseResult,
  WireFsEntry,
  WireFsHomeResult,
  WireGoalSnapshot,
  WireMessage,
  WireModel,
  WireOAuthCancelResult,
  WireOAuthLoginPollResult,
  WireOAuthLoginStartResult,
  WirePage,
  WirePromptSubmitResult,
  WirePromptSteerResult,
  WireProvider,
  WireProviderRefreshResult,
  WireSession,
  WireSessionAbortResult,
  WireSessionWarning,
  WireSessionWarningsResponse,
  WireSessionRuntimeStatus,
  WireSessionSnapshot,
  WireWorkspace,
  WireLogoutResult,
} from './wire';
import { DaemonEventSocket } from './ws';

function safeExportFileName(contentDisposition: string | undefined, fallback: string): string {
  if (contentDisposition === undefined) return fallback;
  let candidate: string | undefined;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition)?.[1]?.trim();
  if (encoded !== undefined) {
    try {
      candidate = decodeURIComponent(encoded.replaceAll(/^"|"$/g, ''));
    } catch {
      return fallback;
    }
  } else {
    candidate =
      /filename\s*=\s*"([^"]*)"/i.exec(contentDisposition)?.[1] ??
      /filename\s*=\s*([^;]+)/i.exec(contentDisposition)?.[1]?.trim();
  }
  if (
    candidate === undefined ||
    candidate.length === 0 ||
    candidate.length > 200 ||
    candidate === '.' ||
    candidate === '..' ||
    /[\u0000-\u001F\u007F/\\]/.test(candidate) ||
    !candidate.toLowerCase().endsWith('.zip')
  ) {
    return fallback;
  }
  return candidate;
}

function errorTraceMetadata(err: unknown): Record<string, string | number | undefined> {
  if (typeof err !== 'object' || err === null) return { errorName: typeof err };
  const value = err as {
    name?: unknown;
    code?: unknown;
    requestId?: unknown;
    phase?: unknown;
    status?: unknown;
  };
  return {
    errorName: typeof value.name === 'string' ? value.name : 'Error',
    errorCode: typeof value.code === 'number' ? value.code : undefined,
    requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
    phase: typeof value.phase === 'string' ? value.phase : undefined,
    httpStatus: typeof value.status === 'number' ? value.status : undefined,
  };
}

// ---------------------------------------------------------------------------
// Wire response shapes for endpoints not in shared wire.ts
// ---------------------------------------------------------------------------

interface WireHealth {
  status: 'ok';
  uptime_sec: number;
}

interface WireMeta {
  server_version: string;
  server_id: string;
  started_at: string;
  capabilities: Record<string, boolean>;
  open_in_apps?: string[];
  dangerous_bypass_auth?: boolean;
  /** Engine generation serving the API; older (v1) servers omit the field. */
  backend?: 'v1' | 'v2';
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

interface WireSkillDescriptor {
  name: string;
  description: string;
  path: string;
  source: string;
  type?: string;
  disable_model_invocation?: boolean;
}

interface WireArchiveResult {
  archived: true;
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
  additions: number;
  deletions: number;
  pullRequest?: { number: number; state: string; url: string } | null;
}

interface WireDiffResult {
  path: string;
  diff: string;
}

interface WireTerminal {
  id: string;
  session_id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited';
  created_at: string;
  exited_at?: string;
  exit_code?: number | null;
}

function toAppTerminal(data: WireTerminal): AppTerminal {
  return {
    id: data.id,
    sessionId: data.session_id,
    cwd: data.cwd,
    shell: data.shell,
    cols: data.cols,
    rows: data.rows,
    status: data.status,
    createdAt: data.created_at,
    exitedAt: data.exited_at,
    exitCode: data.exit_code,
  };
}

/**
 * historyCompacted reasons caused by compaction itself. These do NOT trigger a
 * snapshot reload: the client keeps the visible scrollback and renders a
 * divider marker instead. Every other reason (delta_gap, history_rewrite, …)
 * still means "cached messages are stale" and goes through onResync.
 */
function isCompactionReason(reason: string): boolean {
  return reason === 'auto_compact' || reason === 'manual_compact';
}

// ---------------------------------------------------------------------------
// DaemonKimiWebApi
// ---------------------------------------------------------------------------

export class DaemonKimiWebApi implements KimiWebApi {
  private readonly http: DaemonHttpClient;
  private readonly config: KimiApiConfig;

  constructor(config: KimiApiConfig) {
    this.config = config;
    this.http = new DaemonHttpClient(config.serverHttpUrl, {
      clientId: config.clientId,
      clientName: config.clientName,
      clientVersion: config.clientVersion,
      clientUiMode: config.clientUiMode,
    });
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
    serverVersion: string;
    serverId: string;
    startedAt: string;
    capabilities: Record<string, boolean>;
    openInApps: string[];
    dangerousBypassAuth: boolean;
    /** Engine generation: 'v2' = kap-server / agent-core-v2; absent ⇒ 'v1'. */
    backend: 'v1' | 'v2';
  }> {
    const data = await this.http.get<WireMeta>('/meta');
    return {
      serverVersion: data.server_version,
      serverId: data.server_id,
      startedAt: data.started_at,
      capabilities: data.capabilities,
      openInApps: Array.isArray(data.open_in_apps) ? data.open_in_apps : [],
      dangerousBypassAuth: data.dangerous_bypass_auth === true,
      backend: data.backend === 'v2' ? 'v2' : 'v1',
    };
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async listSessions(
    input?: PageRequest & {
      busy?: boolean;
      workspaceId?: string;
      includeArchive?: boolean;
      archivedOnly?: boolean;
      excludeEmpty?: boolean;
    },
  ): Promise<Page<AppSession>> {
    const query: Record<string, string | number | boolean | undefined> = {
      before_id: input?.beforeId,
      after_id: input?.afterId,
      page_size: input?.pageSize,
      busy: input?.busy,
      include_archive: input?.includeArchive,
      archived_only: input?.archivedOnly,
      exclude_empty: input?.excludeEmpty,
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

  // GET /sessions/{id} — fetch one session (deep links to sessions outside the
  // first listSessions page).
  async getSession(sessionId: string): Promise<AppSession> {
    const data = await this.http.get<WireSession>(
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    return toAppSession(data);
  }

  // The daemon has no PATCH on sessions; mutating title/metadata/agent_config
  // (model + runtime controls) goes through POST /sessions/{id}/profile with a
  // SessionUpdate body { title?, metadata?, agent_config? }. Runtime controls in
  // agent_config are dispatched to the matching core RPCs (setModel/setThinking/
  // setPermission/enterPlan|cancelPlan); the live values are read back from
  // GET /sessions/{id}/status (the profile echo's agent_config can be stale/"").
  async updateSession(
    sessionId: string,
    input: {
      title?: string;
      cwd?: string;
      model?: string;
      permissionMode?: string;
      planMode?: boolean;
      swarmMode?: boolean;
      goalObjective?: string;
      goalControl?: 'pause' | 'resume' | 'cancel';
      thinking?: string;
    },
  ): Promise<AppSession> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body['title'] = input.title;
    if (input.cwd !== undefined) body['metadata'] = { cwd: input.cwd };
    const agentConfig: Record<string, unknown> = {};
    if (input.model !== undefined) agentConfig['model'] = input.model;
    if (input.permissionMode !== undefined) agentConfig['permission_mode'] = input.permissionMode;
    if (input.planMode !== undefined) agentConfig['plan_mode'] = input.planMode;
    if (input.swarmMode !== undefined) agentConfig['swarm_mode'] = input.swarmMode;
    if (input.goalObjective !== undefined) agentConfig['goal_objective'] = input.goalObjective;
    if (input.goalControl !== undefined) agentConfig['goal_control'] = input.goalControl;
    if (input.thinking !== undefined) agentConfig['thinking'] = input.thinking;
    if (Object.keys(agentConfig).length > 0) body['agent_config'] = agentConfig;
    const data = await this.http.post<WireSession>(
      `/sessions/${encodeURIComponent(sessionId)}/profile`,
      body,
    );
    return toAppSession(data);
  }

  /**
   * GET /sessions/{id}/status — the session's live runtime state (current model,
   * thinking level, permission mode, plan flag, and context-window usage). This
   * is the source of truth for the status line; Session.agent_config.model can
   * be "" on the read path.
   */
  async getSessionStatus(sessionId: string): Promise<AppSessionRuntimeStatus> {
    const data = await this.http.get<WireSessionRuntimeStatus>(
      `/sessions/${encodeURIComponent(sessionId)}/status`,
    );
    return {
      model: data.model && data.model.length > 0 ? data.model : null,
      thinkingEffort: data.thinking_level,
      permission: data.permission,
      planMode: data.plan_mode === true,
      swarmMode: data.swarm_mode === true,
      contextTokens: data.context_tokens ?? 0,
      maxContextTokens: data.max_context_tokens ?? 0,
      contextUsage: data.context_usage ?? 0,
    };
  }

  /**
   * GET /sessions/{id}/goal — the session's current goal, or null when no goal
   * is active.
   */
  async getSessionGoal(sessionId: string): Promise<AppGoal | null> {
    const data = await this.http.get<WireGoalSnapshot | null>(
      `/sessions/${encodeURIComponent(sessionId)}/goal`,
    );
    return toAppGoal(data);
  }

  async getSessionWarnings(sessionId: string): Promise<WireSessionWarning[]> {
    const data = await this.http.get<WireSessionWarningsResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/warnings`,
    );
    return data.warnings ?? [];
  }

  async archiveSession(sessionId: string): Promise<{ archived: true }> {
    const data = await this.http.post<WireArchiveResult>(
      `/sessions/${encodeURIComponent(sessionId)}:archive`,
      {},
    );
    return data;
  }

  // POST /sessions/{id}:restore — clear the archived flag. The daemon returns
  // the full restored session, so callers can merge it straight back into lists.
  async restoreSession(sessionId: string): Promise<AppSession> {
    const data = await this.http.post<WireSession>(
      `/sessions/${encodeURIComponent(sessionId)}:restore`,
      {},
    );
    return toAppSession(data);
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

  /**
   * v2 initial sync: atomic session state at an `as_of_seq` watermark.
   * Rebuild flow: getSessionSnapshot() → seedSnapshot() → subscribe(cursor).
   */
  async getSessionSnapshot(sessionId: string): Promise<AppSessionSnapshot> {
    const startedAt = Date.now();
    traceKeyEvent('session:snapshot:start', { sessionId });
    try {
      const data = await this.http.get<WireSessionSnapshot>(
        `/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      );
      const snapshot: AppSessionSnapshot = {
        asOfSeq: data.as_of_seq,
        epoch: data.epoch,
        session: toAppSession(data.session),
        // Snapshot messages are already chronological ascending.
        messages: data.messages.items.map(toAppMessage),
        hasMoreMessages: data.messages.has_more,
        inFlightTurn:
          data.in_flight_turn === null
            ? null
            : {
                turnId: data.in_flight_turn.turn_id,
                assistantText: data.in_flight_turn.assistant_text,
                thinkingText: data.in_flight_turn.thinking_text,
                runningTools: data.in_flight_turn.running_tools.map((t) => ({
                  toolCallId: t.tool_call_id,
                  name: t.name,
                  args: t.args,
                  description: t.description,
                  lastProgress: t.last_progress,
                })),
                promptId: data.in_flight_turn.current_prompt_id,
              },
        pendingApprovals: data.pending_approvals.map(toAppApprovalRequest),
        pendingQuestions: data.pending_questions.map(toAppQuestionRequest),
        // Older servers omit the roster entirely; treat as an empty roster.
        subagents: (data.subagents ?? []).map(toAppTask),
      };
      traceKeyEvent('session:snapshot:accepted', {
        sessionId,
        busy: snapshot.session.busy,
        seq: snapshot.asOfSeq,
        messageCount: snapshot.messages.length,
        durationMs: Date.now() - startedAt,
      });
      return snapshot;
    } catch (error) {
      traceKeyEvent('session:snapshot:failed', {
        sessionId,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        ...errorTraceMetadata(error),
      });
      throw error;
    }
  }

  async exportSession(
    sessionId: string,
    webLog?: string,
  ): Promise<{ blob: Blob; fileName: string }> {
    const webLogBytes = webLog === undefined ? 0 : new TextEncoder().encode(webLog).byteLength;
    const webLogEntries = webLog === undefined || webLog.length === 0 ? 0 : webLog.split('\n').length;
    const result = await this.http.postZip(
      `/sessions/${encodeURIComponent(sessionId)}/export`,
      { web_log: webLog },
      { web_log_bytes: webLogBytes, web_log_entries: webLogEntries },
    );
    const fallback = `${sessionId}.zip`;
    return {
      blob: result.blob,
      fileName: safeExportFileName(result.contentDisposition, fallback),
    };
  }

  // -------------------------------------------------------------------------
  // Prompt
  // -------------------------------------------------------------------------

  async submitPrompt(
    sessionId: string,
    input: PromptSubmission,
  ): Promise<PromptSubmitResult> {
    const startedAt = Date.now();
    traceKeyEvent('prompt:start', {
      sessionId,
      contentCount: input.content.length,
      mediaCount: input.content.filter((part) =>
        part.type === 'image' || part.type === 'video' || part.type === 'file'
      ).length,
    });
    try {
      const data = await this.http.post<WirePromptSubmitResult>(
        `/sessions/${encodeURIComponent(sessionId)}/prompts`,
        toWirePromptSubmission(input),
      );
      traceKeyEvent('prompt:accepted', {
        sessionId,
        promptId: data.prompt_id,
        status: data.status,
        durationMs: Date.now() - startedAt,
      });
      return {
        promptId: data.prompt_id,
        userMessageId: data.user_message_id,
        status: data.status,
      };
    } catch (error) {
      traceKeyEvent('prompt:failed', {
        sessionId,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        ...errorTraceMetadata(error),
      });
      throw error;
    }
  }

  // POST /sessions/{id}/prompts:steer — steer daemon-queued prompts into the
  // active turn (TUI ctrl+s). Throws PROMPT_NOT_FOUND when there is no active
  // turn anymore (the queued prompt then starts its own turn — callers may
  // treat that as success).
  async steerPrompts(
    sessionId: string,
    promptIds: string[],
  ): Promise<{ steered: boolean; promptIds: string[] }> {
    const data = await this.http.post<WirePromptSteerResult>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts:steer`,
      { prompt_ids: promptIds },
    );
    return { steered: data.steered, promptIds: data.prompt_ids };
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

  // POST /sessions/{id}:abort — cancel whatever is running in the session,
  // including skill activations that bypass IPromptService.
  async abortSession(sessionId: string): Promise<{ aborted: boolean }> {
    const data = await this.http.post<WireSessionAbortResult>(
      `/sessions/${encodeURIComponent(sessionId)}:abort`,
      {},
    );
    return { aborted: data.aborted };
  }

  // POST /sessions/{id}:compact — request history compaction. Returns {};
  // progress and completion arrive via the WS compaction.* events (the
  // transcript itself is not reloaded — a divider marker is appended).
  async compactSession(sessionId: string, instruction?: string): Promise<void> {
    await this.http.post(
      `/sessions/${encodeURIComponent(sessionId)}:compact`,
      instruction ? { instruction } : {},
    );
  }

  // POST /sessions/{id}:undo — remove the last `count` turns from history. The
  // response carries the resulting messages + status, but we re-sync the session
  // afterwards for the authoritative (un-paginated) transcript, so we only need
  // the call to succeed here.
  async undoSession(sessionId: string, count = 1): Promise<void> {
    await this.http.post(
      `/sessions/${encodeURIComponent(sessionId)}:undo`,
      { count },
    );
  }

  // POST /sessions/{id}:fork — fork the session into a new child session.
  async forkSession(sessionId: string, input?: { title?: string }): Promise<AppSession> {
    const body: Record<string, unknown> = {};
    if (input?.title !== undefined) body['title'] = input.title;
    const data = await this.http.post<WireSession>(
      `/sessions/${encodeURIComponent(sessionId)}:fork`,
      body,
    );
    return toAppSession(data);
  }

  // POST /sessions/{id}/children — create a child ("side chat") session. The
  // daemon forks the parent (so the child inherits its context) and tags it with
  // parent_session_id + child_session_kind.
  async createChildSession(sessionId: string, input?: { title?: string }): Promise<AppSession> {
    const body: Record<string, unknown> = {};
    if (input?.title !== undefined) body['title'] = input.title;
    const data = await this.http.post<WireSession>(
      `/sessions/${encodeURIComponent(sessionId)}/children`,
      body,
    );
    return toAppSession(data);
  }

  // GET /sessions/{id}/children — list a session's child sessions.
  async listChildSessions(sessionId: string): Promise<AppSession[]> {
    const data = await this.http.get<WirePage<WireSession>>(
      `/sessions/${encodeURIComponent(sessionId)}/children`,
    );
    return data.items.map(toAppSession);
  }

  // POST /sessions/{id}:btw — start a TUI-style side-channel agent. Follow-up
  // prompts use the returned agent_id on the normal /prompts route.
  async startBtw(sessionId: string): Promise<{ agentId: string }> {
    const data = await this.http.post<{ agent_id: string }>(
      `/sessions/${encodeURIComponent(sessionId)}:btw`,
      {},
    );
    return { agentId: data.agent_id };
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
    const data = await this.http.get<{ items: WireTask[] }>(
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
    const data = await this.http.get<WireTask>(
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

  async listTerminals(sessionId: string): Promise<AppTerminal[]> {
    const data = await this.http.get<{ items: WireTerminal[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/terminals`,
    );
    return data.items.map(toAppTerminal);
  }

  async createTerminal(
    sessionId: string,
    input: { cwd?: string; shell?: string; cols?: number; rows?: number } = {},
  ): Promise<AppTerminal> {
    const body: Record<string, unknown> = {
      cwd: input.cwd,
      shell: input.shell,
      cols: input.cols,
      rows: input.rows,
    };
    const data = await this.http.post<WireTerminal>(
      `/sessions/${encodeURIComponent(sessionId)}/terminals`,
      body,
    );
    return toAppTerminal(data);
  }

  async getTerminal(sessionId: string, terminalId: string): Promise<AppTerminal> {
    const data = await this.http.get<WireTerminal>(
      `/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}`,
    );
    return toAppTerminal(data);
  }

  async closeTerminal(sessionId: string, terminalId: string): Promise<{ closed: true }> {
    return this.http.post<{ closed: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}:close`,
    );
  }

  // -------------------------------------------------------------------------
  // Skills — slash-invocable skills (session- or workspace-scoped)
  // GET  /sessions/{id}/skills              → { skills: WireSkillDescriptor[] }
  // GET  /workspaces/{id}/skills            → { skills: WireSkillDescriptor[] } (no session)
  // POST /sessions/{id}/skills/{name}:activate body { args? } → { activated, skill_name }
  // -------------------------------------------------------------------------

  async listSkills(sessionId: string): Promise<AppSkill[]> {
    const data = await this.http.get<{ skills: WireSkillDescriptor[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/skills`,
    );
    return (data.skills ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
    }));
  }

  async listSkillsForWorkspace(workspaceId: string): Promise<AppSkill[]> {
    const data = await this.http.get<{ skills: WireSkillDescriptor[] }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills`,
    );
    return (data.skills ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
    }));
  }

  async activateSkill(
    sessionId: string,
    skillName: string,
    args?: string,
  ): Promise<{ activated: true; skillName: string }> {
    const data = await this.http.post<{ activated: true; skill_name: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/skills/${encodeURIComponent(skillName)}:activate`,
      args !== undefined && args.length > 0 ? { args } : {},
    );
    return { activated: data.activated, skillName: data.skill_name };
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
  ): Promise<{ branch: string; ahead: number; behind: number; entries: Record<string, string>; additions: number; deletions: number; pullRequest: { number: number; state: string; url: string } | null }> {
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
      additions: data.additions,
      deletions: data.deletions,
      pullRequest: data.pullRequest ?? null,
    };
  }

  async getFileDiff(
    sessionId: string,
    path: string,
  ): Promise<{ path: string; diff: string }> {
    const data = await this.http.post<WireDiffResult>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:diff`,
      { path },
    );
    return { path: data.path, diff: data.diff };
  }

  getFileDownloadUrl(sessionId: string, path: string): string {
    const encodedPath = path.split('/').map((part) => encodeURIComponent(part)).join('/');
    return buildRestUrl(
      this.config.serverHttpUrl,
      `/sessions/${encodeURIComponent(sessionId)}/fs/${encodedPath}:download`,
    );
  }

  async openFile(
    sessionId: string,
    input: { path: string; line?: number },
  ): Promise<{ opened: true }> {
    const body: Record<string, unknown> = { path: input.path };
    if (input.line !== undefined) body['line'] = input.line;
    return this.http.post<{ opened: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:open`,
      body,
    );
  }

  async revealFile(
    sessionId: string,
    input: { path: string },
  ): Promise<{ revealed: true }> {
    return this.http.post<{ revealed: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:reveal`,
      { path: input.path },
    );
  }

  async openInApp(
    sessionId: string,
    appId: string,
    path: string,
    line?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = { app_id: appId, path };
    if (line !== undefined) body['line'] = line;
    await this.http.post<{ opened: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/fs:open-in`,
      body,
    );
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
   * PRESUMED — POST /api/v1/workspaces { root, name? }. Throws on error (e.g.
   * path not found) so the caller can surface it to the user.
   */
  async addWorkspace(input: { root: string; name?: string }): Promise<AppWorkspace> {
    const body: Record<string, unknown> = { root: input.root };
    if (input.name !== undefined) body['name'] = input.name;
    const data = await this.http.post<WireWorkspace>('/workspaces', body);
    return toAppWorkspace(data);
  }

  /**
   * Remove a registered workspace.
   * PRESUMED — DELETE /api/v1/workspaces/:id. On error this throws.
   */
  async deleteWorkspace(id: string): Promise<void> {
    await this.http.delete(`/workspaces/${encodeURIComponent(id)}`);
  }

  /**
   * Rename a workspace (display name only).
   * PATCH /api/v1/workspaces/:id { name }. On error this throws.
   */
  async updateWorkspace(id: string, input: { name: string }): Promise<AppWorkspace> {
    const data = await this.http.patch<WireWorkspace>(
      `/workspaces/${encodeURIComponent(id)}`,
      { name: input.name },
    );
    return toAppWorkspace(data);
  }

  /**
   * Browse directories under `path` (defaults to $HOME on the daemon).
   * PRESUMED — GET /api/v1/fs:browse?path=. On error returns an empty path so
   * the picker can distinguish "browse failed" from "directory has no children".
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
        })),
      };
    } catch {
      return { path: '', parent: null, entries: [] };
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

  async refreshProvider(id: string): Promise<ProviderRefreshResult> {
    const data = await this.http.post<WireProviderRefreshResult>(
      `/providers/${encodeURIComponent(id)}:refresh`,
    );
    return toProviderRefreshResult(data);
  }

  async refreshAllProviders(): Promise<ProviderRefreshResult> {
    const data = await this.http.post<WireProviderRefreshResult>('/providers:refresh');
    return toProviderRefreshResult(data);
  }

  async refreshOAuthProviderModels(): Promise<ProviderRefreshResult> {
    const data = await this.http.post<WireProviderRefreshResult>('/providers:refresh_oauth');
    return toProviderRefreshResult(data);
  }

  // -------------------------------------------------------------------------
  // Config — REAL endpoints
  // -------------------------------------------------------------------------

  async getConfig(): Promise<AppConfig> {
    const data = await this.http.get<WireConfig>('/config');
    return toAppConfig(data);
  }

  async setConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const wirePatch: Record<string, unknown> = {};
    const keyMap: Record<keyof AppConfig, string> = {
      providers: 'providers',
      defaultProvider: 'default_provider',
      defaultModel: 'default_model',
      models: 'models',
      thinking: 'thinking',
      planMode: 'plan_mode',
      yolo: 'yolo',
      defaultPermissionMode: 'default_permission_mode',
      defaultPlanMode: 'default_plan_mode',
      permission: 'permission',
      hooks: 'hooks',
      services: 'services',
      mergeAllAvailableSkills: 'merge_all_available_skills',
      extraSkillDirs: 'extra_skill_dirs',
      loopControl: 'loop_control',
      background: 'background',
      experimental: 'experimental',
      telemetry: 'telemetry',
      raw: 'raw',
    };
    for (const [key, value] of Object.entries(patch)) {
      const wireKey = keyMap[key as keyof AppConfig];
      if (wireKey !== undefined) {
        wirePatch[wireKey] = value;
      }
    }
    const data = await this.http.post<WireConfig>('/config', wirePatch);
    return toAppConfig(data);
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

  async startOAuthLogin(): Promise<OAuthLoginStartResult> {
    const data = await this.http.post<WireOAuthLoginStartResult>('/oauth/login', {});
    if (data.status === 'authenticated') {
      return {
        flowId: data.flow_id,
        provider: data.provider,
        status: 'authenticated',
      };
    }
    return {
      flowId: data.flow_id,
      provider: data.provider,
      status: 'pending',
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      userCode: data.user_code,
      expiresIn: data.expires_in,
      interval: data.interval,
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

  getFileUrl(fileId: string): string {
    return buildRestUrl(this.config.serverHttpUrl, `/files/${encodeURIComponent(fileId)}`);
  }

  /** Fetch a file's bytes with the Bearer credential attached. Use this (not
   *  getFileUrl) when the bytes feed a <video>/<img> src: the browser loads
   *  those natively without the Authorization header, so the URL alone 401s. */
  async getFileBlob(fileId: string): Promise<Blob> {
    return this.http.getBlob(`/files/${encodeURIComponent(fileId)}`);
  }

  // -------------------------------------------------------------------------
  // WebSocket events
  // -------------------------------------------------------------------------

  connectEvents(handlers: KimiEventHandlers): KimiEventConnection {
    const wsUrl = buildWsUrl(this.config.serverHttpUrl, this.config.clientId);

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

        // Route history_compacted to onResync so the client reloads messages —
        // EXCEPT for compaction itself: the transcript keeps the scrollback and
        // the reducer appends a divider marker instead (reloading would replace
        // the visible conversation with the compacted model context).
        if (appEvent.type === 'historyCompacted' && !isCompactionReason(appEvent.reason)) {
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
        const { type, seq, session_id: sessionId, payload, offset } = frame;
        const appEvents = projector.project(type, payload, sessionId, { offset });
        for (const appEvent of appEvents) {
          const turnId = (payload as { turnId?: unknown } | null)?.turnId;
          const stream =
            appEvent.type === 'assistantDelta' &&
            typeof turnId === 'number' &&
            typeof offset === 'number' &&
            (type === 'assistant.delta' || type === 'thinking.delta')
              ? {
                  turnId,
                  offset,
                  kind: type === 'assistant.delta' ? ('text' as const) : ('thinking' as const),
                }
              : undefined;
          // historyCompacted from the projector is either a compaction signal
          // (reason auto_compact — no reload, the divider marker handles it) or
          // a delta-gap recovery (reason delta_gap — a real resync, routed to
          // onResync with the real frame.seq, mirroring the protocol path).
          if (appEvent.type === 'historyCompacted' && !isCompactionReason(appEvent.reason)) {
            handlers.onResync(sessionId, seq);
          }
          handlers.onEvent(appEvent, { sessionId, seq, stream });
        }
      },

      onResync: (sessionId: string, currentSeq: number, epoch?: string) => {
        // Reset per-session projector state on resync
        projector.reset(sessionId);
        handlers.onResync(sessionId, currentSeq, epoch);
      },

      onConnectionState: (connected: boolean) => {
        handlers.onConnectionChange(connected);
      },

      onError: (code: number, msg: string, fatal: boolean) => {
        handlers.onError(code, msg, fatal);
      },

      onTerminalOutput: (sessionId, terminalId, data, seq) => {
        handlers.onTerminalOutput?.(sessionId, terminalId, data, seq);
      },

      onTerminalExit: (sessionId, terminalId, exitCode) => {
        handlers.onTerminalExit?.(sessionId, terminalId, exitCode);
      },
    });

    socket.connect();

    return {
      subscribe(sessionId: string, cursor?: AppSessionCursor): void {
        // Do NOT reset projector state here: every sidebar click re-subscribes
        // the (possibly running) session, and a reset wipes the turn/prompt
        // bindings — the remainder of an in-flight turn would be dropped on
        // the floor. The projector starts sessions fresh on first sight, and
        // onResync (below) resets explicitly before messages are reloaded.
        socket.subscribe(sessionId, cursor ?? { seq: 0 });
      },
      unsubscribe(sessionId: string): void {
        socket.unsubscribe(sessionId);
      },
      seedSnapshot(sessionId: string, snapshot: AppSessionSnapshot): void {
        // Rebuild the projector's mid-turn state from the snapshot. The
        // resulting AppEvent (the partially-streamed assistant message) flows
        // through the SAME onEvent path as live events, so the rendering layer
        // needs no special handling; session status comes from the snapshot's
        // authoritative session record. When there is no in-flight turn we
        // only reset, so stale turn state can't leak into the freshly-loaded
        // message list.
        if (snapshot.inFlightTurn === null) {
          projector.reset(sessionId);
          return;
        }
        const appEvents = projector.seedInFlight(sessionId, snapshot.inFlightTurn);
        for (const appEvent of appEvents) {
          handlers.onEvent(appEvent, { sessionId, seq: snapshot.asOfSeq });
        }
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
      terminalAttach(sessionId: string, terminalId: string, sinceSeq?: number): void {
        socket.terminalAttach(sessionId, terminalId, sinceSeq);
      },
      terminalInput(sessionId: string, terminalId: string, data: string): void {
        socket.terminalInput(sessionId, terminalId, data);
      },
      terminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void {
        socket.terminalResize(sessionId, terminalId, cols, rows);
      },
      terminalDetach(sessionId: string, terminalId: string): void {
        socket.terminalDetach(sessionId, terminalId);
      },
      terminalClose(sessionId: string, terminalId: string): void {
        socket.terminalClose(sessionId, terminalId);
      },
      markSideChannelAgent(agentId: string): void {
        projector.markSideChannelAgent(agentId);
      },
      health(): { connected: boolean; open: boolean; stale: boolean } {
        return socket.health();
      },
      reconnect(): void {
        socket.reconnect();
      },
      close(): void {
        socket.close();
      },
    };
  }
}

function toProviderRefreshResult(data: WireProviderRefreshResult): ProviderRefreshResult {
  return {
    changed: data.changed.map((item) => ({
      providerId: item.provider_id,
      providerName: item.provider_name,
      added: item.added,
      removed: item.removed,
    })),
    unchanged: data.unchanged,
    failed: data.failed,
  };
}

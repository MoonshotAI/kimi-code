/**
 * `DaemonClient` — wire-level test client for the kimi-code daemon.
 *
 * Wraps the daemon's HTTP REST + WS surfaces (`/api/v1/...` + `/api/v1/ws`)
 * into a single, typed object that scenarios can drive. Handles:
 *   - Envelope unwrap + typed REST helpers
 *   - WS `server_hello` → `client_hello` → ack handshake
 *   - `subscribe` / `unsubscribe` ack correlation
 *   - Approval + question reverse-RPC auto-resolve via per-event handlers
 *   - `waitForFrame` / `waitForSessionStatus` convenience waits
 *
 * **What it is NOT**: a daemon bootstrap helper. Connect to a daemon process
 * that's already running at `baseUrl` (default `http://127.0.0.1:7878`).
 */
import type {
  ApprovalRequest,
  ApprovalResolveResult,
  ApprovalResponse,
  AuthSummary,
  CompactSessionRequest,
  CompactSessionResponse,
  FileMeta,
  ForkSessionRequest,
  FsBrowseResponse,
  FsHomeResponse,
  ListModelsResponse,
  ListPendingApprovalsResponse,
  ListPendingQuestionsResponse,
  ListProvidersResponse,
  Message,
  ProviderCatalogItem,
  PromptAbortResponse,
  PromptPermissionMode,
  PromptSubmission,
  PromptSubmitResult,
  PromptThinking,
  QuestionRequest,
  QuestionResolveResult,
  QuestionResponse,
  ServerHelloMessage,
  SetDefaultModelResponse,
  Session,
  SessionChildCreate,
  SessionCreate,
  SessionStatus,
  SessionUpdate,
  Workspace,
  WorkspaceCreate,
  WorkspaceUpdate,
} from '@moonshot-ai/protocol';
import { ulid } from 'ulid';
import { WebSocket as WsWebSocket } from 'ws';

import { HttpClient } from './http.js';
import { installReverseRpcHandler } from './reverse-rpc.js';
import { DEFAULT_FRAME_TIMEOUT_MS, waitForSessionStatus } from './wait.js';
import { type AnyFrame, WsClient } from './ws.js';

export interface DaemonClientOptions {
  /** Default `http://127.0.0.1:7878`. */
  baseUrl?: string;
  /** Default `/api/v1`. WS endpoint is `${apiPrefix}/ws`. */
  apiPrefix?: string;
  /** Default `daemon-e2e-<ulid>` — used as the `client_hello.client_id`. */
  clientId?: string;
  fetchImpl?: typeof fetch;
  wsImpl?: typeof WsWebSocket;
  logger?: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta?: unknown) => void;
  /** Directory for JSONL trace events and generated HTML reports. */
  reportDir?: string;
  /** Default 5s. Applies to handshake + subscribe acks. */
  controlAckTimeoutMs?: number;
}

export interface SubmitAndWaitOptions {
  /** Default `prompt.completed`. */
  waitFor?: 'prompt.completed' | 'turn.ended';
  /** Default 60s. */
  timeoutMs?: number;
}

type UploadFileData = Blob | ArrayBuffer | Uint8Array | string;

const DEFAULT_BASE_URL = 'http://127.0.0.1:7878';
const DEFAULT_API_PREFIX = '/api/v1';
const DEFAULT_CONTROL_ACK_TIMEOUT_MS = 5_000;

/**
 * Per-request stateless session controls that the daemon REST surface
 * requires on every prompt submission. Scenarios that don't care about
 * these can leave them at the defaults; tests that exercise switching
 * model / thinking / permission / plan mode override only the field
 * they need.
 *
 * `model` matches what the existing daemon-e2e scenarios assume (the
 * default provider exposes `kimi-code/kimi-for-coding`).
 */
export const DEFAULT_PROMPT_CONTROLS = {
  model: 'kimi-code/kimi-for-coding',
  thinking: 'off' as PromptThinking,
  permission_mode: 'manual' as PromptPermissionMode,
  plan_mode: false,
} as const;

/**
 * Looser input shape for `submitPrompt` / `submitAndWait`. `content` is
 * required; the four stateless controls fall back to
 * `DEFAULT_PROMPT_CONTROLS` when omitted. `metadata` carries through
 * verbatim.
 */
export type PromptSubmitInput =
  Pick<PromptSubmission, 'content'>
  & Partial<Pick<PromptSubmission, 'metadata' | 'model' | 'thinking' | 'permission_mode' | 'plan_mode'>>;

function fillPromptDefaults(input: PromptSubmitInput): PromptSubmission {
  return { ...DEFAULT_PROMPT_CONTROLS, ...input };
}

export class DaemonClient {
  readonly baseUrl: string;
  readonly apiPrefix: string;
  readonly clientId: string;
  readonly http: HttpClient;

  private readonly _wsImpl: typeof WsWebSocket;
  private readonly _logger: (
    level: 'info' | 'warn' | 'error' | 'debug',
    msg: string,
    meta?: unknown,
  ) => void;
  private readonly _reportDir: string | undefined;
  private readonly _controlAckTimeoutMs: number;
  private _ws: WsClient | null = null;
  private _serverHello: ServerHelloMessage['payload'] | null = null;
  private readonly _subscribed = new Set<string>();
  private readonly _disposers: Array<() => void> = [];

  constructor(opts: DaemonClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiPrefix = opts.apiPrefix ?? DEFAULT_API_PREFIX;
    this.clientId = opts.clientId ?? `daemon-e2e-${ulid()}`;
    this._wsImpl = opts.wsImpl ?? WsWebSocket;
    this._logger = opts.logger ?? noopLogger;
    this._reportDir = opts.reportDir;
    this._controlAckTimeoutMs = opts.controlAckTimeoutMs ?? DEFAULT_CONTROL_ACK_TIMEOUT_MS;
    this.http = new HttpClient({
      baseUrl: this.baseUrl,
      apiPrefix: this.apiPrefix,
      fetchImpl: opts.fetchImpl ?? fetch,
      reportDir: this._reportDir,
    });
  }

  // ── Probes + model catalog ─────────────────────────────────────────────
  getAuth(): Promise<AuthSummary> {
    return this.http.getAuth();
  }
  listModels(): Promise<ListModelsResponse> {
    return this.http.listModels();
  }
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    return this.http.setDefaultModel(modelId);
  }
  listProviders(): Promise<ListProvidersResponse> {
    return this.http.listProviders();
  }
  getProvider(providerId: string): Promise<ProviderCatalogItem> {
    return this.http.getProvider(providerId);
  }

  // ── HTTP convenience surface ────────────────────────────────────────────
  createSession(body: SessionCreate): Promise<Session> {
    return this.http.createSession(body);
  }
  getSession(sid: string): Promise<Session> {
    return this.http.getSession(sid);
  }
  listSessions(
    query?: { page_size?: number; before_id?: string; after_id?: string; workspace_id?: string },
  ): Promise<{ items: Session[]; has_more: boolean }> {
    return this.http.listSessions(query);
  }
  updateSession(sid: string, body: SessionUpdate): Promise<Session> {
    return this.http.updateSession(sid, body);
  }
  forkSession(sid: string, body: ForkSessionRequest = {}): Promise<Session> {
    return this.http.forkSession(sid, body);
  }
  compactSession(
    sid: string,
    body: CompactSessionRequest = {},
  ): Promise<CompactSessionResponse> {
    return this.http.compactSession(sid, body);
  }
  deleteSession(sid: string): Promise<{ deleted: true }> {
    return this.http.deleteSession(sid);
  }
  listChildren(
    sid: string,
    query?: { page_size?: number; before_id?: string; after_id?: string; status?: Session['status'] },
  ): Promise<{ items: Session[]; has_more: boolean }> {
    return this.http.listChildren(sid, query);
  }
  createChild(sid: string, body: SessionChildCreate = {}): Promise<Session> {
    return this.http.createChild(sid, body);
  }

  // ── Workspaces + folder picker ──────────────────────────────────────────
  listWorkspaces(): Promise<{ items: Workspace[] }> {
    return this.http.listWorkspaces();
  }
  createWorkspace(body: WorkspaceCreate): Promise<Workspace> {
    return this.http.createWorkspace(body);
  }
  updateWorkspace(workspaceId: string, body: WorkspaceUpdate): Promise<Workspace> {
    return this.http.updateWorkspace(workspaceId, body);
  }
  deleteWorkspace(workspaceId: string): Promise<{ deleted: true }> {
    return this.http.deleteWorkspace(workspaceId);
  }
  fsBrowse(path?: string): Promise<FsBrowseResponse> {
    return this.http.fsBrowse(path);
  }
  fsHome(): Promise<FsHomeResponse> {
    return this.http.fsHome();
  }
  uploadFile(input: {
    name: string;
    data: UploadFileData;
    mediaType?: string;
    expiresInSec?: number;
  }): Promise<FileMeta> {
    return this.http.uploadFile(input);
  }
  deleteFile(fileId: string): Promise<{ deleted: true }> {
    return this.http.deleteFile(fileId);
  }
  listMessages(
    sid: string,
    query?: { page_size?: number; before_id?: string; after_id?: string; role?: string },
  ): Promise<{ items: Message[]; has_more: boolean }> {
    return this.http.listMessages(sid, query);
  }
  submitPrompt(sid: string, input: PromptSubmitInput): Promise<PromptSubmitResult> {
    return this.http.submitPrompt(sid, fillPromptDefaults(input));
  }
  /**
   * Stateful-session submit — sends `body` to `POST /sessions/{sid}/prompts`
   * verbatim, with NO default controls injected. Pair with
   * `updateSession(sid, {agent_config: {...}})` (or `submitPrompt` with the
   * legacy default-filled path) to first establish session state, then
   * exercise the "content-only prompt inherits session state" contract.
   */
  submitPromptStateful(
    sid: string,
    body: PromptSubmission,
  ): Promise<PromptSubmitResult> {
    return this.http.submitPrompt(sid, body);
  }
  abortPrompt(sid: string, pid: string): Promise<PromptAbortResponse> {
    return this.http.abortPrompt(sid, pid);
  }
  resolveApproval(
    sid: string,
    aid: string,
    body: ApprovalResponse,
  ): Promise<ApprovalResolveResult> {
    return this.http.resolveApproval(sid, aid, body);
  }
  listPendingApprovals(sid: string): Promise<ListPendingApprovalsResponse> {
    return this.http.listPendingApprovals(sid);
  }
  resolveQuestion(
    sid: string,
    qid: string,
    body: QuestionResponse,
  ): Promise<QuestionResolveResult> {
    return this.http.resolveQuestion(sid, qid, body);
  }
  listPendingQuestions(sid: string): Promise<ListPendingQuestionsResponse> {
    return this.http.listPendingQuestions(sid);
  }
  dismissQuestion(
    sid: string,
    qid: string,
  ): Promise<{ dismissed: true; dismissed_at: string }> {
    return this.http.dismissQuestion(sid, qid);
  }

  // ── WS lifecycle ────────────────────────────────────────────────────────
  /**
   * Open the WS socket, wait for `server_hello`, send `client_hello`, await
   * the ack. Returns the server's hello payload (heartbeat config, etc.).
   */
  async connect(): Promise<ServerHelloMessage['payload']> {
    if (this._serverHello) return this._serverHello;
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}${this.apiPrefix}/ws`;
    const ws = new WsClient({
      url: wsUrl,
      wsImpl: this._wsImpl,
      logger: this._logger,
      reportDir: this._reportDir,
    });
    this._ws = ws;
    await ws.open();

    const helloFrame = await ws.waitForFrame(
      (f) => f.type === 'server_hello',
      this._controlAckTimeoutMs,
    );
    const helloPayload = helloFrame.payload as ServerHelloMessage['payload'];
    this._serverHello = helloPayload;

    const helloId = `hello-${ulid()}`;
    const ack = await ws.sendAndAwaitAck(
      {
        type: 'client_hello',
        id: helloId,
        payload: { client_id: this.clientId, subscriptions: [] },
      },
      this._controlAckTimeoutMs,
    );
    if (ack.code !== 0) {
      throw new Error(`client_hello rejected (code=${ack.code}): ${ack.msg ?? 'no message'}`);
    }
    this._logger('debug', 'ws: handshake complete', {
      wsConnectionId: helloPayload.ws_connection_id,
      clientId: this.clientId,
    });
    return helloPayload;
  }

  /** Send `subscribe` and await its ack. Tracks the session for `close()`. */
  async subscribe(sid: string): Promise<void> {
    const ws = this._requireWs();
    if (this._subscribed.has(sid)) return;
    const id = `sub-${ulid()}`;
    const ack = await ws.sendAndAwaitAck(
      { type: 'subscribe', id, payload: { session_ids: [sid] } },
      this._controlAckTimeoutMs,
    );
    if (ack.code !== 0) {
      throw new Error(`subscribe rejected (code=${ack.code}): ${ack.msg ?? 'no message'}`);
    }
    this._subscribed.add(sid);
  }

  /** Send `unsubscribe` and await its ack. */
  async unsubscribe(sid: string): Promise<void> {
    const ws = this._requireWs();
    if (!this._subscribed.has(sid)) return;
    const id = `unsub-${ulid()}`;
    const ack = await ws.sendAndAwaitAck(
      { type: 'unsubscribe', id, payload: { session_ids: [sid] } },
      this._controlAckTimeoutMs,
    );
    if (ack.code !== 0) {
      throw new Error(`unsubscribe rejected (code=${ack.code}): ${ack.msg ?? 'no message'}`);
    }
    this._subscribed.delete(sid);
  }

  /** Close the socket. Idempotent. */
  async close(): Promise<void> {
    for (const dispose of this._disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    if (this._ws) {
      await this._ws.close();
      this._ws = null;
    }
    this._serverHello = null;
    this._subscribed.clear();
  }

  // ── WS observation ──────────────────────────────────────────────────────
  /** Subscribe to ALL incoming frames. Returns an unsubscribe handle. */
  onFrame(handler: (frame: AnyFrame) => void): () => void {
    return this._requireWs().onFrame(handler);
  }

  /** Wait for the next frame satisfying `predicate`. */
  waitForFrame(
    predicate: (frame: AnyFrame) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<AnyFrame> {
    return this._requireWs().waitForFrame(
      predicate,
      opts?.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
    );
  }

  /** Poll `/sessions/{sid}` until it reaches `status`. */
  waitForSessionStatus(
    sid: string,
    status: SessionStatus,
    opts?: { timeoutMs?: number; pollMs?: number },
  ): Promise<Session> {
    return waitForSessionStatus(this.http, sid, status, opts);
  }

  // ── Reverse RPC (approval + question) ───────────────────────────────────
  /**
   * Install a handler invoked on every `event.approval.requested` frame.
   * The handler's return value is POSTed to `/sessions/{sid}/approvals/{aid}`.
   * Returns an unsubscribe handle (also auto-disposed by `close()`).
   */
  onApprovalRequested(
    handler: (req: ApprovalRequest) => Promise<ApprovalResponse> | ApprovalResponse,
  ): () => void {
    const ws = this._requireWs();
    const unsubscribe = installReverseRpcHandler<ApprovalRequest, ApprovalResponse>(ws, {
      requestEventType: 'event.approval.requested',
      idField: 'approval_id',
      buildPath: (sid, aid) => `/sessions/${sid}/approvals/${aid}`,
      handler,
      postResolve: (sid, aid, body) => this.http.resolveApproval(sid, aid, body),
      logger: this._logger,
    });
    this._disposers.push(unsubscribe);
    return () => {
      const idx = this._disposers.indexOf(unsubscribe);
      if (idx >= 0) this._disposers.splice(idx, 1);
      unsubscribe();
    };
  }

  /**
   * Install a handler invoked on every `event.question.requested` frame.
   * Returns an unsubscribe handle (also auto-disposed by `close()`).
   */
  onQuestionAsked(
    handler: (req: QuestionRequest) => Promise<QuestionResponse> | QuestionResponse,
  ): () => void {
    const ws = this._requireWs();
    const unsubscribe = installReverseRpcHandler<QuestionRequest, QuestionResponse>(ws, {
      requestEventType: 'event.question.requested',
      idField: 'question_id',
      buildPath: (sid, qid) => `/sessions/${sid}/questions/${qid}`,
      handler,
      postResolve: (sid, qid, body) => this.http.resolveQuestion(sid, qid, body),
      logger: this._logger,
    });
    this._disposers.push(unsubscribe);
    return () => {
      const idx = this._disposers.indexOf(unsubscribe);
      if (idx >= 0) this._disposers.splice(idx, 1);
      unsubscribe();
    };
  }

  // ── High-level convenience ──────────────────────────────────────────────
  /**
   * Submit a prompt and wait for its terminal event. `waitFor` defaults to
   * the synthesized `prompt.completed` event (broadcast after `turn.ended`
   * lands for the same prompt). Returns `prompt_id` and the matching frame.
   */
  async submitAndWait(
    sid: string,
    input: PromptSubmitInput,
    opts: SubmitAndWaitOptions = {},
  ): Promise<{ prompt_id: string; user_message_id: string; finalFrame: AnyFrame }> {
    const ws = this._requireWs();
    const waitFor = opts.waitFor ?? 'prompt.completed';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;

    // POST the prompt FIRST — without `prompt_id` we have nothing to match on.
    // The WS layer queues every frame from the moment we open, so any events
    // that arrive between this POST and the `waitForFrame` below are still
    // there to be matched (they're drained from the queue, not dropped).
    const submit = await this.http.submitPrompt(sid, fillPromptDefaults(input));

    const finalFrame = await ws.waitForFrame((f) => {
      if (f.type !== waitFor) return false;
      const payload = (f.payload as { promptId?: string; prompt_id?: string } | undefined) ?? {};
      const pid = payload.promptId ?? payload.prompt_id;
      return pid === submit.prompt_id;
    }, timeoutMs);

    return { prompt_id: submit.prompt_id, user_message_id: submit.user_message_id, finalFrame };
  }

  /**
   * Stateful-session companion to `submitAndWait` — POSTs `body` verbatim
   * (NO default controls injected), then waits for the terminal event for
   * the resulting `prompt_id`. Use after `updateSession(sid, {agent_config:
   * {...}})` to verify the session's shadow drives the next prompt without
   * the body needing to redeclare any controls.
   */
  async submitAndWaitStateful(
    sid: string,
    body: PromptSubmission,
    opts: SubmitAndWaitOptions = {},
  ): Promise<{ prompt_id: string; user_message_id: string; finalFrame: AnyFrame }> {
    const ws = this._requireWs();
    const waitFor = opts.waitFor ?? 'prompt.completed';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
    const submit = await this.http.submitPrompt(sid, body);
    const finalFrame = await ws.waitForFrame((f) => {
      if (f.type !== waitFor) return false;
      const payload = (f.payload as { promptId?: string; prompt_id?: string } | undefined) ?? {};
      const pid = payload.promptId ?? payload.prompt_id;
      return pid === submit.prompt_id;
    }, timeoutMs);
    return { prompt_id: submit.prompt_id, user_message_id: submit.user_message_id, finalFrame };
  }

  // ── internals ───────────────────────────────────────────────────────────
  private _requireWs(): WsClient {
    if (!this._ws) {
      throw new Error('ws not connected — call `await client.connect()` first');
    }
    return this._ws;
  }
}

function noopLogger(): void {
  // intentionally blank
}

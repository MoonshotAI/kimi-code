import type {
  FsBrowseResponse,
  FsHomeResponse,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import type { AuthSummary } from '@moonshot-ai/agent-core-v2/app/authLegacy/authLegacy';
import type { FileMeta } from '@moonshot-ai/agent-core-v2/app/file/fileService';
import type { UpdateSessionProfileRequest as SessionUpdate } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';
import type {
  ProviderCatalogItem,
  SetDefaultModelResponse,
} from '@moonshot-ai/agent-core-v2/llm-adapter/model/catalog';
import type {
  InteractionRespondRequest,
  InteractionRespondResult,
} from '@moonshot-ai/kap-server/protocol/interaction';
import type {
  ListModelsResponse,
  ListProvidersResponse,
} from '@moonshot-ai/kap-server/protocol/rest-modelCatalog';
import type {
  PromptAbortResponse,
  PromptListResponse,
  PromptPermissionMode,
  PromptSubmission,
  PromptSteerResult,
  PromptSubmitResult,
  PromptThinking,
} from '@moonshot-ai/kap-server/protocol/rest-prompt';
import type { ConversationTurnsPage } from '@moonshot-ai/kap-server/protocol/conversation';
import type {
  CancelSessionRequest,
  CompactSessionRequest,
  CompactSessionResponse,
  ForkSessionRequest,
  SessionCancelResponse,
  UndoSessionRequest,
  UndoSessionResponse,
  UpdateSessionProfileResponse,
} from '@moonshot-ai/kap-server/protocol/rest-session';
import type {
  Session,
  SessionCreate,
} from '@moonshot-ai/kap-server/protocol/session';
import type {
  Workspace,
  WorkspaceCreate,
  WorkspaceUpdate,
} from '@moonshot-ai/kap-server/protocol/workspace';
import { ulid } from 'ulid';
import { WebSocket as WsWebSocket } from 'ws';

import { HttpClient } from './http.js';
import { DEFAULT_FRAME_TIMEOUT_MS, waitForSessionBusy } from './wait.js';
import { type AnyFrame, WsClient } from './ws.js';

export interface DaemonClientOptions {
  baseUrl?: string;
  apiPrefix?: string;
  fetchImpl?: typeof fetch;
  wsImpl?: typeof WsWebSocket;
  logger?: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta?: unknown) => void;
  reportDir?: string;
  controlAckTimeoutMs?: number;
}

export interface SubmitAndWaitOptions {
  timeoutMs?: number;
}

export interface SubmitAndWaitResult {
  prompt_id: string;
  user_message_id: string;
  finalFrame: AnyFrame;
}

type UploadFileData = Blob | ArrayBuffer | Uint8Array | string;

const DEFAULT_BASE_URL = 'http://127.0.0.1:58627';
const DEFAULT_API_PREFIX = '/api/v1';
const DEFAULT_CONTROL_ACK_TIMEOUT_MS = 5_000;

export const DEFAULT_PROMPT_CONTROLS = {
  model: 'kimi-code/kimi-for-coding',
  thinking: 'off' as PromptThinking,
  permission_mode: 'manual' as PromptPermissionMode,
  plan_mode: false,
} as const;

export type PromptSubmitInput =
  Pick<PromptSubmission, 'content'>
  & Partial<Pick<PromptSubmission, 'metadata' | 'model' | 'thinking' | 'permission_mode' | 'plan_mode'>>;

function fillPromptDefaults(input: PromptSubmitInput): PromptSubmission {
  return { ...DEFAULT_PROMPT_CONTROLS, ...input };
}

export class DaemonClient {
  readonly baseUrl: string;
  readonly apiPrefix: string;
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
  private _connecting: Promise<void> | null = null;
  private readonly _subscribed = new Set<string>();
  private readonly _disposers: Array<() => void> = [];

  constructor(opts: DaemonClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiPrefix = opts.apiPrefix ?? DEFAULT_API_PREFIX;
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
  updateSession(sid: string, body: SessionUpdate): Promise<UpdateSessionProfileResponse> {
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
  undoSession(
    sid: string,
    body: UndoSessionRequest,
  ): Promise<UndoSessionResponse> {
    return this.http.undoSession(sid, body);
  }
  archiveSession(sid: string): Promise<{ archived: true }> {
    return this.http.archiveSession(sid);
  }

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
  listTurns(sid: string): Promise<ConversationTurnsPage> {
    return this.http.listTurns(sid);
  }
  submitPrompt(sid: string, input: PromptSubmitInput): Promise<PromptSubmitResult> {
    return this.http.submitPrompt(sid, fillPromptDefaults(input));
  }
  submitPromptStateful(
    sid: string,
    body: PromptSubmission,
  ): Promise<PromptSubmitResult> {
    return this.http.submitPrompt(sid, body);
  }
  listPrompts(sid: string): Promise<PromptListResponse> {
    return this.http.listPrompts(sid);
  }
  steerPrompts(sid: string, promptIds: readonly string[]): Promise<PromptSteerResult> {
    return this.http.steerPrompts(sid, promptIds);
  }
  abortPrompt(sid: string, pid: string): Promise<PromptAbortResponse> {
    return this.http.abortPrompt(sid, pid);
  }
  cancelSession(sid: string, body: CancelSessionRequest = {}): Promise<SessionCancelResponse> {
    return this.http.cancelSession(sid, body);
  }
  respondInteraction(
    sid: string,
    interactionId: string,
    body: InteractionRespondRequest,
  ): Promise<InteractionRespondResult> {
    return this.http.respondInteraction(sid, interactionId, body);
  }

  connect(): Promise<void> {
    this._connecting ??= this._open().catch((error: unknown) => {
      this._connecting = null;
      throw error;
    });
    return this._connecting;
  }

  private async _open(): Promise<void> {
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}${this.apiPrefix}/ws`;
    const ws = new WsClient({
      url: wsUrl,
      wsImpl: this._wsImpl,
      logger: this._logger,
      reportDir: this._reportDir,
    });
    await ws.open();
    this._ws = ws;
  }

  async subscribe(sid: string): Promise<void> {
    const ws = this._requireWs();
    if (this._subscribed.has(sid)) return;
    const response = await ws.sendCommand(
      { type: 'subscribe', request_id: `sub-${ulid()}`, session_id: sid },
      this._controlAckTimeoutMs,
    );
    if (response.code !== 0) {
      throw new Error(`subscribe rejected (code=${response.code}): ${response.msg ?? 'no message'}`);
    }
    this._subscribed.add(sid);
  }

  async unsubscribe(sid: string): Promise<void> {
    const ws = this._requireWs();
    if (!this._subscribed.has(sid)) return;
    const response = await ws.sendCommand(
      { type: 'unsubscribe', request_id: `unsub-${ulid()}`, session_id: sid },
      this._controlAckTimeoutMs,
    );
    if (response.code !== 0) {
      throw new Error(`unsubscribe rejected (code=${response.code}): ${response.msg ?? 'no message'}`);
    }
    this._subscribed.delete(sid);
  }

  async close(): Promise<void> {
    for (const dispose of this._disposers.splice(0)) {
      try {
        dispose();
      } catch {}
    }
    const connecting = this._connecting;
    this._connecting = null;
    await connecting?.catch(() => undefined);
    if (this._ws) {
      await this._ws.close();
      this._ws = null;
    }
    this._subscribed.clear();
  }

  onFrame(handler: (frame: AnyFrame) => void): () => void {
    return this._requireWs().onFrame(handler);
  }

  waitForFrame(
    predicate: (frame: AnyFrame) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<AnyFrame> {
    return this._requireWs().waitForFrame(
      predicate,
      opts?.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
    );
  }

  waitForSessionBusy(
    sid: string,
    busy: boolean,
    opts?: { timeoutMs?: number; pollMs?: number },
  ): Promise<Session> {
    return waitForSessionBusy(this.http, sid, busy, opts);
  }

  async runUntilIdle<T>(
    sid: string,
    action: () => Promise<T>,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ result: T; finalFrame: AnyFrame }> {
    const ws = this._requireWs();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
    let dispose = (): void => {};
    const idle = new Promise<AnyFrame>((resolve, reject) => {
      let sawBusy = false;
      const timer = setTimeout(() => {
        dispose();
        reject(new Error(`session ${sid} did not return to idle within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      const off = ws.onFrame((frame) => {
        if (frame.type !== 'session' || frame['change'] !== 'updated') return;
        const session = frame['session'] as { id?: string; activity?: string } | undefined;
        if (session?.id !== sid || typeof session.activity !== 'string') return;
        const busy = session.activity !== 'idle';
        if (busy) {
          sawBusy = true;
        } else if (sawBusy) {
          dispose();
          resolve(frame);
        }
      });
      dispose = () => {
        clearTimeout(timer);
        off();
      };
    });
    try {
      const result = await action();
      return { result, finalFrame: await idle };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  async submitAndWait(
    sid: string,
    input: PromptSubmitInput,
    opts: SubmitAndWaitOptions = {},
  ): Promise<SubmitAndWaitResult> {
    return this.submitAndWaitStateful(sid, fillPromptDefaults(input), opts);
  }

  async submitAndWaitStateful(
    sid: string,
    body: PromptSubmission,
    opts: SubmitAndWaitOptions = {},
  ): Promise<SubmitAndWaitResult> {
    const { result, finalFrame } = await this.runUntilIdle(
      sid,
      () => this.http.submitPrompt(sid, body),
      opts,
    );
    return { prompt_id: result.prompt_id, user_message_id: result.user_message_id, finalFrame };
  }

  private _requireWs(): WsClient {
    if (!this._ws) {
      throw new Error('ws not connected — call `await client.connect()` first');
    }
    return this._ws;
  }
}

function noopLogger(): void {}

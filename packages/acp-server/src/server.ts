/**
 * ACP `AgentSideConnection` handler backed directly by `agent-core-v2`.
 *
 * `initialize`, the session lifecycle (`session/new`, `/load`, `/resume`,
 * `/list`, `/close`), `session/prompt`, `session/cancel`, the config surface
 * (model / mode / thinking), slash commands, skills, approval / question
 * bridging (`session/request_permission`), and `session/load` history replay
 * are wired to the `ISessionLifecycleService` / `ISessionIndex`, the
 * per-session main agent, and the `ISessionInteractionService` kernel. MCP
 * forwarding and terminal reverse-RPC land in later phases.
 */

import { randomUUID } from 'node:crypto';

import {
  type Agent,
  type AgentCapabilities,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientCapabilities,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  RequestError,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import {
  ensureMainAgent,
  type IAgentScopeHandle,
  IAuthSummaryService,
  IConfigService,
  IAgentProfileService,
  ISessionIndex,
  ISessionLifecycleService,
  type ISessionScopeHandle,
  type Scope,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';

import { buildTerminalAuthMethod, TERMINAL_AUTH_METHOD } from './auth-methods';
import { log } from './log';
import { isAcpModeId } from './modes';
import { AcpSession } from './session';

export interface AcpServerOptions {
  /** Agent identity advertised in `initialize.agentInfo`. */
  readonly agentInfo?: Implementation;
  /**
   * Bypass the auth gate (`IAuthSummaryService`). Intended for tests and local
   * dev — production ACP hosts should leave this `false` so unauthenticated
   * clients get a structured `auth_required` before any session is created.
   */
  readonly disableAuth?: boolean;
  /**
   * Env vars to advertise in `authMethods[0].env` so the `kimi login`
   * subprocess the client spawns (via terminal-auth) lands its token under the
   * same data root the server uses (e.g. `{ KIMI_CODE_HOME: '/tmp/...' }` for
   * sandboxed test setups). Leave undefined in production so the advertised
   * env stays empty.
   */
  readonly terminalAuthEnv?: Readonly<Record<string, string>>;
  /**
   * Absolute binary path advertised in `_meta['terminal-auth'].command` for
   * clients that don't yet honor the first-class `type:'terminal'`. Defaults
   * to undefined (the `_meta` fallback is omitted).
   */
  readonly terminalAuthLegacyCommand?: string;
}

export class AcpServer implements Agent {
  private clientCapabilities: ClientCapabilities | undefined;
  private readonly agentInfo: Implementation | undefined;
  private readonly disableAuth: boolean;
  private readonly terminalAuthEnv: Readonly<Record<string, string>> | undefined;
  private readonly terminalAuthLegacyCommand: string | undefined;
  private readonly sessions = new Map<string, AcpSession>();

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly core: Scope,
    opts: AcpServerOptions = {},
  ) {
    this.agentInfo = opts.agentInfo;
    this.disableAuth = opts.disableAuth ?? false;
    this.terminalAuthEnv = opts.terminalAuthEnv;
    this.terminalAuthLegacyCommand = opts.terminalAuthLegacyCommand;
  }

  /** Returns the client capabilities advertised during `initialize`, if any. */
  get clientCaps(): ClientCapabilities | undefined {
    return this.clientCapabilities;
  }

  /** @internal — for tests/inspection only. */
  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities;

    const agentCapabilities: AgentCapabilities = {
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: true,
      },
      mcpCapabilities: {
        http: true,
        sse: true,
      },
      sessionCapabilities: {
        list: {},
        resume: {},
        close: {},
      },
    };

    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities,
      authMethods: [
        this.terminalAuthEnv !== undefined || this.terminalAuthLegacyCommand !== undefined
          ? buildTerminalAuthMethod({
              env: this.terminalAuthEnv,
              legacyCommand: this.terminalAuthLegacyCommand,
            })
          : TERMINAL_AUTH_METHOD,
      ],
      ...(this.agentInfo ? { agentInfo: this.agentInfo } : {}),
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    await this.ensureAuthed();
    const sessionId = `session_${randomUUID()}`;
    const handle = await this.core.accessor
      .get(ISessionLifecycleService)
      .create({ sessionId, workDir: params.cwd });
    const acpSession = await this.wireSession(handle, sessionId);
    this.sessions.set(sessionId, acpSession);
    void acpSession.emitAvailableCommandsUpdate();
    return { sessionId, configOptions: acpSession.configOptions() };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    await this.ensureAuthed();
    const handle = await this.resumeHandle(params.sessionId);
    const acpSession = await this.wireSession(handle, params.sessionId);
    this.sessions.set(params.sessionId, acpSession);
    // Replay the persisted history as an ordered batch of `session/update`
    // notifications BEFORE settling, so the client re-renders prior turns
    // before the load response lands. This is the one differentiator vs.
    // `resumeSession`, which deliberately skips replay per the ACP spec.
    await acpSession.replayHistory();
    void acpSession.emitAvailableCommandsUpdate();
    return { configOptions: acpSession.configOptions() };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    await this.ensureAuthed();
    const handle = await this.resumeHandle(params.sessionId);
    const acpSession = await this.wireSession(handle, params.sessionId);
    this.sessions.set(params.sessionId, acpSession);
    void acpSession.emitAvailableCommandsUpdate();
    return { configOptions: acpSession.configOptions() };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const cwd = params.cwd ?? undefined;
    // ACP `cwd` ↔ session `cwd`. Filtering by workspaceId is a later phase;
    // for now list everything (the client filters by cwd on its side).
    void cwd;
    const page = await this.core.accessor.get(ISessionIndex).list({});
    const sessions: SessionInfo[] = page.items.map(sessionSummaryToSessionInfo);
    return { sessions, nextCursor: page.nextCursor ?? null };
  }

  /**
   * Handle ACP `session/close`. Cancels any in-flight turn, tears down the
   * per-session ACP resources (interaction bridge), and asks the engine to
   * dispose the live session scope. Best-effort: an unknown or already-closed
   * session id is not an error — `close` is a cleanup operation, and
   * `ISessionLifecycleService.close` is a no-op for a session that is not
   * currently live.
   */
  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (acpSession !== undefined) {
      acpSession.dispose();
      this.sessions.delete(params.sessionId);
    }
    await this.core.accessor.get(ISessionLifecycleService).close(params.sessionId);
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    if (params.methodId !== 'login') {
      throw RequestError.invalidParams(
        { methodId: params.methodId },
        `Unknown auth method: ${params.methodId}`,
      );
    }
    // Re-check the gate; clients spawn `kimi login` themselves via the
    // terminal-auth method and re-invoke `authenticate('login')` to confirm the
    // token landed. `void` = empty success body.
    await this.ensureAuthed();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(undefined, `Unknown sessionId: ${params.sessionId}`);
    }
    return acpSession.prompt(params.prompt);
  }

  async cancel(params: CancelNotification): Promise<void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      // `session/cancel` is a notification — the spec forbids returning errors.
      log.warn('acp: cancel for unknown sessionId', { sessionId: params.sessionId });
      return;
    }
    try {
      acpSession.cancel();
    } catch (error) {
      log.warn('acp: error while cancelling session', {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    if (!isAcpModeId(params.modeId)) {
      throw RequestError.invalidParams(
        { modeId: params.modeId },
        `Unknown modeId: ${params.modeId}`,
      );
    }
    await acpSession.setMode(params.modeId);
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    await acpSession.setModel(params.modelId);
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    const value = (params as { value: unknown }).value;
    switch (params.configId) {
      case 'model':
        await acpSession.setModel(String(value));
        break;
      case 'mode': {
        if (!isAcpModeId(value)) {
          throw RequestError.invalidParams(
            { modeId: value },
            `Unknown modeId: ${String(value)}`,
          );
        }
        await acpSession.setMode(value);
        break;
      }
      case 'thinking':
        await acpSession.setThinking(value === 'on');
        break;
      default:
        throw RequestError.invalidParams(
          { configId: params.configId },
          `Unknown configId: ${params.configId}`,
        );
    }
    return { configOptions: acpSession.configOptions() };
  }

  async extMethod(
    method: string,
    _params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    throw RequestError.methodNotFound(method);
  }

  async extNotification(method: string, _params: Record<string, unknown>): Promise<void> {
    throw RequestError.methodNotFound(method);
  }

  /**
   * Resume a persisted session into the live scope tree. Maps an unknown
   * session id to ACP `invalid_params` (-32602) rather than a generic internal
   * error.
   */
  private async resumeHandle(sessionId: string): Promise<ISessionScopeHandle> {
    const handle = await this.core.accessor.get(ISessionLifecycleService).resume(sessionId);
    if (handle === undefined) {
      throw RequestError.invalidParams({ sessionId }, `Unknown sessionId: ${sessionId}`);
    }
    return handle;
  }

  /**
   * Ensure the main agent exists for a session and bind the configured default
   * model (best-effort — a missing default model leaves the agent unbound, and
   * `prompt` settles gracefully until a model is set via `set_config_option`).
   */
  private async wireSession(handle: ISessionScopeHandle, sessionId: string): Promise<AcpSession> {
    const main = await ensureMainAgent(handle);
    await this.bindDefaultModel(main);
    return new AcpSession(this.conn, handle, main, sessionId);
  }

  private async bindDefaultModel(main: IAgentScopeHandle): Promise<void> {
    try {
      const profile = main.accessor.get(IAgentProfileService);
      if (profile.isRunnable()) return;
      const inspected = this.core.accessor.get(IConfigService).inspect<string>('defaultModel');
      const model = inspected.value;
      if (typeof model === 'string' && model.length > 0) {
        await profile.setModel(model);
      }
    } catch (error) {
      log.warn('acp: default model binding skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Auth gate: throws `auth_required` unless authed (or `disableAuth`). */
  private async ensureAuthed(): Promise<void> {
    if (this.disableAuth) return;
    const summaries = await this.core.accessor.get(IAuthSummaryService).summarize();
    const authed = summaries.some((s) => s.loggedIn);
    if (!authed) {
      throw RequestError.authRequired();
    }
  }
}

/**
 * Project an agent-core-v2 {@link SessionSummary} into the ACP
 * {@link SessionInfo} shape used by `session/list`.
 */
function sessionSummaryToSessionInfo(summary: SessionSummary): SessionInfo {
  let updatedAt: string | null = null;
  if (typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)) {
    const date = new Date(summary.updatedAt);
    if (!Number.isNaN(date.getTime())) {
      updatedAt = date.toISOString();
    }
  }
  const titleRaw = summary.title;
  const title = typeof titleRaw === 'string' && titleRaw.length > 0 ? titleRaw : null;
  return {
    sessionId: summary.id,
    cwd: summary.cwd ?? '',
    title,
    updatedAt,
  };
}

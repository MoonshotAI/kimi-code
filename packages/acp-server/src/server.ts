/**
 * ACP `AgentSideConnection` handler backed by the `Klient` facade (in-memory
 * transport by default — see `./start`).
 *
 * `initialize`, the session lifecycle (`session/new`, `/load`, `/resume`,
 * `/list`, `/close`), `session/prompt`, `session/cancel`, and the config
 * surface (model / mode; thinking is hidden until klient exposes it) are
 * wired to `klient.global.sessions`, `klient.session(id)` lifecycle +
 * interactions, and the per-session main agent handle (`klient.session(id).
 * agent('main')`). Slash commands, skills, approval / question bridging
 * (`session/request_permission`), and `session/load` history replay live in
 * `./session` / `./interaction-bridge`. MCP forwarding and terminal
 * reverse-RPC land in later phases.
 */

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
import type { AgentHandle, Klient, SessionSummary } from '@moonshot-ai/klient';

import type { IAcpConnection } from './acp-fs';
import { buildTerminalAuthMethod, TERMINAL_AUTH_METHOD } from './auth-methods';
import { log } from './log';
import { isAcpModeId } from './modes';
import { AcpSession } from './session';

/** The ACP protocol version this server implements. */
const PROTOCOL_VERSION = 1;

export interface AcpServerOptions {
  /** Agent identity advertised in `initialize.agentInfo`. */
  readonly agentInfo?: Implementation;
  /**
   * Bypass the auth gate (`klient.global.auth.summarize()`). Intended for
   * tests and local dev — production ACP hosts should leave this `false` so
   * unauthenticated clients get a structured `auth_required` before any
   * session is created.
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
    private readonly klient: Klient,
    /**
     * The engine-side ACP connection holder (host file-IO reverse-RPC). This
     * is a composition-root concern, not a klient facade concern — `start.ts`
     * resolves it from the bootstrapped scope and passes it in.
     */
    private readonly acpConnection: IAcpConnection,
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
    this.acpConnection.bindFsCapabilities(params.clientCapabilities?.fs);

    const agentCapabilities: AgentCapabilities = {
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: true,
      },
      sessionCapabilities: {
        list: {},
        resume: {},
        close: {},
      },
    };

    return {
      protocolVersion: PROTOCOL_VERSION,
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
    // The engine mints the session id and registers the workspace for the cwd
    // implicitly. ACP `mcpServers` are not forwarded (as before — the facade
    // `create` has no slot for them yet).
    const meta = await this.klient.global.sessions.create({ workDir: params.cwd });
    const sessionId = meta.id;
    const acpSession = await this.wireSession(sessionId);
    this.sessions.set(sessionId, acpSession);
    void acpSession.emitAvailableCommandsUpdate();
    return { sessionId, configOptions: await acpSession.configOptions() };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    await this.ensureAuthed();
    const acpSession = await this.resumeAcpSession(params.sessionId);
    // Replay the persisted history as an ordered batch of `session/update`
    // notifications BEFORE settling, so the client re-renders prior turns
    // before the load response lands. This is the one differentiator vs.
    // `resumeSession`, which deliberately skips replay per the ACP spec.
    await acpSession.replayHistory();
    void acpSession.emitAvailableCommandsUpdate();
    return { configOptions: await acpSession.configOptions() };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    await this.ensureAuthed();
    const acpSession = await this.resumeAcpSession(params.sessionId);
    void acpSession.emitAvailableCommandsUpdate();
    return { configOptions: await acpSession.configOptions() };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const cwd = params.cwd ?? undefined;
    const page = await this.klient.global.sessions.list({});
    // Filter by cwd when the client supplies one. SessionSummary.cwd is optional
    // (sessions written before cwd was persisted); those are excluded when a
    // filter is active.
    const items = cwd !== undefined ? page.items.filter((s) => s.cwd === cwd) : page.items;
    const sessions: SessionInfo[] = items.map(sessionSummaryToSessionInfo);
    return { sessions, nextCursor: page.nextCursor ?? null };
  }

  /**
   * Handle ACP `session/close`. Cancels any in-flight turn, tears down the
   * per-session ACP resources (interaction bridge, event subscriptions), and
   * asks the engine to dispose the live session scope. Best-effort: an
   * unknown or already-closed session id is not an error — `close` is a
   * cleanup operation, and the lifecycle close is a no-op for a session that
   * is not currently live.
   */
  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (acpSession !== undefined) {
      acpSession.dispose();
      this.sessions.delete(params.sessionId);
    }
    await this.klient.session(params.sessionId).close();
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
          throw RequestError.invalidParams({ modeId: value }, `Unknown modeId: ${String(value)}`);
        }
        await acpSession.setMode(value);
        break;
      }
      case 'thinking':
        // KLIENT-GAP(thinking): the option is never advertised (see
        // `AcpSession.configOptions`); reject stale clients explicitly instead
        // of pretending the toggle took effect.
        throw RequestError.invalidParams(
          { configId: params.configId },
          'thinking is not configurable: klient exposes no thinking surface yet',
        );
      default:
        throw RequestError.invalidParams(
          { configId: params.configId },
          `Unknown configId: ${params.configId}`,
        );
    }
    return { configOptions: await acpSession.configOptions() };
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
   * Resume a persisted session into the live scope tree and build its ACP
   * session. An unknown session id maps to ACP `invalid_params` (-32602)
   * rather than a generic internal error.
   */
  private async resumeAcpSession(sessionId: string): Promise<AcpSession> {
    // `restore` re-materializes a persisted session (a live one passes
    // through) and reports `false` only when the id no longer exists.
    const restored = await this.klient.session(sessionId).restore();
    if (!restored) {
      throw RequestError.invalidParams({ sessionId }, `Unknown sessionId: ${sessionId}`);
    }
    const acpSession = await this.wireSession(sessionId);
    this.sessions.get(sessionId)?.dispose();
    this.sessions.set(sessionId, acpSession);
    return acpSession;
  }

  /**
   * Build the ACP session for a live session: bind the configured default
   * model to the main agent (best-effort — a missing default model leaves the
   * agent unbound, and `prompt` settles gracefully until a model is set via
   * `set_config_option`), then subscribe its event stream.
   */
  private async wireSession(sessionId: string): Promise<AcpSession> {
    await this.bindDefaultModel(this.klient.session(sessionId).agent('main'));
    const acpSession = new AcpSession(this.conn, this.klient, sessionId);
    await acpSession.init();
    return acpSession;
  }

  private async bindDefaultModel(agent: AgentHandle): Promise<void> {
    try {
      // `getModel` is '' while the profile has no model bound (the same guard
      // the old engine-direct binding expressed via `isRunnable()`).
      if ((await agent.getModel()).length > 0) return;
      const inspected = await this.klient.global.config.inspect<string>('defaultModel');
      const model = inspected.value;
      if (typeof model === 'string' && model.length > 0) {
        await agent.setModel(model);
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
    const summaries = await this.klient.global.auth.summarize();
    const authed = summaries.some((s) => s.loggedIn);
    if (!authed) {
      throw RequestError.authRequired();
    }
  }
}

/**
 * Project a wire {@link SessionSummary} into the ACP {@link SessionInfo}
 * shape used by `session/list`.
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

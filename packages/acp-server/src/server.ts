/**
 * ACP agent method handlers backed by the `Klient` facade (in-memory
 * transport by default — see `./start`), routed through the SDK's app API
 * (`agent()` builder + `onRequest` / `onNotification` — see
 * {@link createAcpAgentApp}).
 *
 * `initialize`, the session lifecycle (`session/new`, `/load`, `/resume`,
 * `/list`, `/close`, `/delete`, `/fork`), `session/prompt`, `session/cancel`, and the
 * config surface (model / mode / thinking) are
 * wired to `klient.global.sessions`, `klient.session(id)` lifecycle +
 * interactions, and the per-session main agent handle (`klient.session(id).
 * agent('main')`). Slash commands, skills, approval / question bridging
 * (`session/request_permission`), and `session/load` history replay live in
 * `./session` / `./interaction-bridge`. ACP `mcpServers` on `session/new` /
 * `/load` / `/resume` are converted to the engine's name-keyed record (see
 * `./convert`) and injected as ephemeral per-session MCP servers. When the
 * client advertises `clientCapabilities.terminal`, Bash executions reverse-RPC
 * through the client terminal (`./acp-terminal`).
 */

import {
  agent,
  type AgentApp,
  type AgentCapabilities,
  type AuthenticateRequest,
  type AvailableCommand,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientCapabilities,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutRequest,
  type LogoutResponse,
  methods,
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
} from '@agentclientprotocol/sdk';
import type {
  AgentHandle,
  Klient,
  SessionHandle,
  SessionRestoreOptions,
  SessionSummary,
} from '@moonshot-ai/klient';
import { RPCError } from '@moonshot-ai/klient';

import type { AcpClient } from './acp-client';
import type { IAcpConnection } from './acp-fs';
import { buildTerminalAuthMethod, TERMINAL_AUTH_METHOD } from './auth-methods';
import { acpMcpServersToConfigRecord } from './convert';
import { log } from './log';
import { isAcpModeId } from './modes';
import { AcpSession } from './session';
import { negotiateVersion } from './version';

/**
 * Klient's stable wire code for "session not found" (`RPCError.code`) — the
 * branch key across the wire, mirrored from the klient facade's `NOT_FOUND`.
 */
const SESSION_NOT_FOUND_CODE = 40404;

/** Host-provided slash commands plus optional aliases that activate engine skills. */
export interface SlashCommandsSnapshot {
  readonly commands: ReadonlyArray<AvailableCommand>;
  readonly skillCommandMap?: ReadonlyMap<string, string>;
}

export type SlashCommandsResolver =
  | ReadonlyArray<AvailableCommand>
  | SlashCommandsSnapshot
  | ((
      session: SessionHandle,
    ) =>
      | Promise<ReadonlyArray<AvailableCommand> | SlashCommandsSnapshot>
      | ReadonlyArray<AvailableCommand>
      | SlashCommandsSnapshot);

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
  /**
   * Resolve a session's media-originals dir for prompt-image compression.
   * This is a composition-root concern (it reads the live engine scope tree,
   * not the klient facade) — `start.ts` builds it from the bootstrapped App
   * scope. Absent → `persistOriginalImage`'s shared temp-dir fallback.
   */
  readonly resolveOriginalsDir?: (sessionId: string) => string | undefined;
  /** Static or per-session host command palette, compatible with acp-adapter. */
  readonly slashCommands?: SlashCommandsResolver;
}

export class AcpServer {
  private clientCapabilities: ClientCapabilities | undefined;
  private readonly agentInfo: Implementation | undefined;
  private readonly disableAuth: boolean;
  private readonly terminalAuthEnv: Readonly<Record<string, string>> | undefined;
  private readonly terminalAuthLegacyCommand: string | undefined;
  private readonly resolveOriginalsDir: ((sessionId: string) => string | undefined) | undefined;
  private readonly resolveSlashCommands: (
    session: SessionHandle,
  ) => Promise<ReadonlyArray<AvailableCommand> | SlashCommandsSnapshot>;
  private readonly sessions = new Map<string, AcpSession>();

  constructor(
    private readonly conn: AcpClient,
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
    this.resolveOriginalsDir = opts.resolveOriginalsDir;
    const slashCommands = opts.slashCommands;
    this.resolveSlashCommands =
      typeof slashCommands === 'function'
        ? async (session) => slashCommands(session)
        : async () => slashCommands ?? [];
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
    this.acpConnection.bindTerminalCapability(params.clientCapabilities?.terminal === true);
    // Answer with the highest mutually-supported protocol version (a client
    // advertising a newer major, e.g. 99, still gets our current version).
    const negotiated = negotiateVersion(params.protocolVersion);

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
        delete: {},
        // UNSTABLE per the SDK schema — declared as-is: the engine + klient
        // fork path is fully wired (`unstable_forkSession` below).
        fork: {},
        // Honored on `session/new` only — see the KLIENT-GAP note in
        // `loadSession` / `resumeSession`.
        additionalDirectories: {},
      },
      // Stdio is the implied baseline in ACP (no capability flag); we also
      // forward http/sse servers to the engine. The unstable ACP transport
      // is not supported (dropped with a warning — see `./convert`).
      mcpCapabilities: { http: true, sse: true },
      auth: { logout: {} },
    };

    return {
      protocolVersion: negotiated.protocolVersion,
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
    // implicitly. ACP `mcpServers` become ephemeral per-session servers
    // (connected for this session only, never persisted).
    const meta = await this.klient.global.sessions.create({
      workDir: params.cwd,
      additionalDirs: params.additionalDirectories,
      mcpServers: acpMcpServersToConfigRecord(params.mcpServers),
    });
    return { sessionId: meta.id, ...(await this.activateSession(meta.id)) };
  }

  /**
   * Handle ACP `session/fork` (UNSTABLE in the SDK schema). Forks the source
   * session through the engine (`sessionLifecycleService.fork` via the klient
   * facade) and manages the forked session exactly like a `session/new` one —
   * same response surface (`sessionId` + `configOptions` + `modes`), same
   * local `AcpSession` wiring. The engine fork inherits the source session's
   * workspace and carries no slot for `cwd` / `additionalDirectories` /
   * `mcpServers` (ephemeral servers are not carried over), so those request
   * fields are ignored with a warning, mirroring load/resume. An unknown
   * source id maps to ACP `invalid_params` (-32602).
   */
  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    await this.ensureAuthed();
    this.warnIgnoredAdditionalDirs('session/fork', params.additionalDirectories);
    if (params.mcpServers !== undefined && params.mcpServers.length > 0) {
      log.warn('acp: session/fork ignores mcpServers (engine fork keeps the source servers)', {
        servers: params.mcpServers.map((server) => server.name),
      });
    }
    let forkedId: string;
    try {
      forkedId = (await this.klient.session(params.sessionId).fork()).id;
    } catch (error) {
      if (error instanceof RPCError && error.code === SESSION_NOT_FOUND_CODE) {
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          `Unknown sessionId: ${params.sessionId}`,
        );
      }
      throw error;
    }
    return { sessionId: forkedId, ...(await this.activateSession(forkedId)) };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    await this.ensureAuthed();
    this.warnIgnoredAdditionalDirs('session/load', params.additionalDirectories);
    const acpSession = await this.resumeAcpSession(
      params.sessionId,
      acpMcpServersToConfigRecord(params.mcpServers),
    );
    // Replay the persisted history as an ordered batch of `session/update`
    // notifications BEFORE settling, so the client re-renders prior turns
    // before the load response lands. This is the one differentiator vs.
    // `resumeSession`, which deliberately skips replay per the ACP spec.
    await acpSession.replayHistory();
    this.scheduleAvailableCommandsUpdate(acpSession);
    return { configOptions: await acpSession.configOptions(), modes: acpSession.modeState() };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    await this.ensureAuthed();
    this.warnIgnoredAdditionalDirs('session/resume', params.additionalDirectories);
    const acpSession = await this.resumeAcpSession(
      params.sessionId,
      acpMcpServersToConfigRecord(params.mcpServers),
    );
    this.scheduleAvailableCommandsUpdate(acpSession);
    return { configOptions: await acpSession.configOptions(), modes: acpSession.modeState() };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const cwd = params.cwd ?? undefined;
    const page = await this.klient.global.sessions.list({});
    const sessions: SessionInfo[] = filterSessionSummariesByCwd(page.items, cwd).map(
      sessionSummaryToSessionInfo,
    );
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

  /**
   * Handle ACP `session/delete`. Permanently removes the session through the
   * engine (`sessionLifecycleService.delete` — closes a live session first,
   * then drops its persisted data and index entries) and tears down any local
   * ACP state for it. Unlike `close`, delete is NOT best-effort: the client
   * asked to remove one specific listed session, so an unknown id maps to ACP
   * `invalid_params` (-32602).
   */
  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    try {
      await this.klient.session(params.sessionId).delete();
    } catch (error) {
      if (error instanceof RPCError && error.code === SESSION_NOT_FOUND_CODE) {
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          `Unknown sessionId: ${params.sessionId}`,
        );
      }
      throw error;
    }
    const acpSession = this.sessions.get(params.sessionId);
    if (acpSession !== undefined) {
      acpSession.dispose();
      this.sessions.delete(params.sessionId);
    }
    return {};
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

  /**
   * Handle ACP `logout`. Drops the managed provider's token through the engine
   * (`oauthService.logout`, which also deprovisions managed config). The auth
   * gate re-derives from `klient.global.auth.summarize()` on every gated call,
   * so no extra state is needed here — the next gated method hits
   * `auth_required` again naturally. `void` = empty success body.
   */
  async logout(_params: LogoutRequest): Promise<LogoutResponse | void> {
    await this.klient.global.auth.logout();
  }

  /**
   * Handle ACP `session/prompt`. `signal` is the app-API per-request abort
   * signal: a JSON-RPC `$/cancel_request` for this request aborts it, and the
   * abort is routed into the exact same cancel path as the `session/cancel`
   * notification ({@link cancel}).
   */
  async prompt(params: PromptRequest, signal?: AbortSignal): Promise<PromptResponse> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(undefined, `Unknown sessionId: ${params.sessionId}`);
    }
    if (signal === undefined) {
      return acpSession.prompt(params.prompt);
    }
    const onAbort = (): void => {
      try {
        acpSession.cancel();
      } catch (error) {
        log.warn('acp: error while cancelling session', {
          sessionId: params.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      // An already-aborted signal never fires the listener — cancel up front.
      if (signal.aborted) onAbort();
      return await acpSession.prompt(params.prompt);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
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
      case 'thinking': {
        // Capability-aware validation lives in the session (allowed set
        // depends on the current model's declared efforts); an unacceptable
        // value maps to `invalid_params`.
        const accepted = await acpSession.setThinking(String(value));
        if (!accepted) {
          throw RequestError.invalidParams(
            { configId: params.configId, value },
            `Unknown thinking value: ${String(value)}`,
          );
        }
        break;
      }
      default:
        throw RequestError.invalidParams(
          { configId: params.configId },
          `Unknown configId: ${params.configId}`,
        );
    }
    return { configOptions: await acpSession.configOptions() };
  }

  /**
   * Handle the custom `session/set_model` request (dropped from the SDK's
   * typed method set in 1.x; preserved here as an extension method — see
   * {@link createAcpAgentApp} for its registration and param parsing).
   * Returns the empty success body.
   */
  async setSessionModel(params: SetSessionModelParams): Promise<Record<string, unknown>> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    await acpSession.setModel(params.modelId);
    return {};
  }

  /**
   * Resume a persisted session into the live scope tree and build its ACP
   * session. An unknown session id maps to ACP `invalid_params` (-32602)
   * rather than a generic internal error. `mcpServers` (already converted to
   * the engine record shape) is forwarded to the re-materialize path; it is
   * ignored when the session is already live (restore passes through).
   */
  private async resumeAcpSession(
    sessionId: string,
    mcpServers?: SessionRestoreOptions['mcpServers'],
  ): Promise<AcpSession> {
    // `restore` re-materializes a persisted session (a live one passes
    // through) and reports `false` only when the id no longer exists.
    const restored = await this.klient.session(sessionId).restore({ mcpServers });
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
    const session = this.klient.session(sessionId);
    await this.bindDefaultModel(session.agent('main'));
    const hostCommands = await this.resolveSlashCommands(session);
    const acpSession = new AcpSession(
      this.conn,
      this.klient,
      sessionId,
      this.acpConnection,
      Boolean(this.clientCapabilities?.elicitation?.form),
      this.resolveOriginalsDir,
      hostCommands,
    );
    await acpSession.init();
    return acpSession;
  }

  /**
   * Bring a freshly created/forked session under local ACP management
   * (wire + register + advertise slash commands) and build the response
   * surface shared by `session/new` and `session/fork`.
   */
  private async activateSession(sessionId: string): Promise<{
    configOptions: Awaited<ReturnType<AcpSession['configOptions']>>;
    modes: ReturnType<AcpSession['modeState']>;
  }> {
    const acpSession = await this.wireSession(sessionId);
    this.sessions.set(sessionId, acpSession);
    this.scheduleAvailableCommandsUpdate(acpSession);
    return { configOptions: await acpSession.configOptions(), modes: acpSession.modeState() };
  }

  /**
   * Push the `available_commands_update` AFTER the triggering lifecycle
   * response (`session/new` / `/fork` / `/load` / `/resume`) has settled.
   * Clients register the session when the response lands and silently drop
   * `session/update` notifications that arrive earlier (Zed), so an eager
   * push leaves the client's slash-command palette empty. Mirrors the legacy
   * adapter's `scheduleAvailableCommandsUpdate` (`acp-adapter/src/server.ts`).
   */
  private scheduleAvailableCommandsUpdate(acpSession: AcpSession): void {
    setTimeout(() => {
      void acpSession.emitAvailableCommandsUpdate();
    }, 0);
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
    // Primary: the engine's own readiness probe for the default model —
    // config-file apiKey / provider env-bag credentials / OAuth token all
    // count, matching how the model is actually used (the OAuth-only
    // `summarize()` view is too narrow on its own).
    try {
      await this.klient.global.auth.ensureReady();
      return;
    } catch (error) {
      log.info('acp: auth readiness probe failed, trying the OAuth summary', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Fallback: any logged-in OAuth provider counts as authed even when the
    // default model is not usable (the legacy adapter's first branch).
    const summaries = await this.klient.global.auth.summarize();
    if (!summaries.some((s) => s.loggedIn)) {
      throw RequestError.authRequired();
    }
  }

  /**
   * KLIENT-GAP(additionalDirectories): the engine merges additional roots only
   * on session create (`workspaceDirs.mergeAdditionalDirs`); load/resume have
   * no merge slot yet, so the field is ignored there with a warning rather
   * than silently honored.
   */
  private warnIgnoredAdditionalDirs(method: string, dirs: readonly string[] | undefined): void {
    if (dirs === undefined || dirs.length === 0) return;
    log.warn(`acp: ${method} ignores additionalDirectories (engine merges dirs only on create)`, {
      dirs,
    });
  }
}

/** The custom ACP method name for per-session model selection. */
const SET_SESSION_MODEL_METHOD = 'session/set_model';

/** Parsed params of the custom `session/set_model` request. */
export interface SetSessionModelParams {
  readonly sessionId: string;
  readonly modelId: string;
}

/**
 * Params parser for the custom `session/set_model` route (the app API
 * requires every custom method to bring its own parser). Hand-rolled rather
 * than zod — this package has no zod dependency, and the narrowing plus the
 * thrown `invalid_params` error are exactly what the legacy `extMethod`
 * path produced.
 */
function parseSetSessionModelParams(params: unknown): SetSessionModelParams {
  const { sessionId, modelId } = (params ?? {}) as Record<string, unknown>;
  if (typeof sessionId !== 'string' || typeof modelId !== 'string') {
    throw RequestError.invalidParams(
      params,
      'session/set_model expects { sessionId: string, modelId: string }',
    );
  }
  return { sessionId, modelId };
}

/**
 * Build the ACP agent app (SDK `agent()` builder) that routes every inbound
 * method to the {@link AcpServer} returned by `getServer`.
 *
 * `getServer` is dereferenced lazily per request because the app must be
 * connected before the outbound client surface (and thus the server) exists
 * — see `./start`. Handlers for unregistered methods never arise here: the
 * connection layer answers unknown requests with `method_not_found` (-32601)
 * and silently drops unknown notifications, matching the legacy
 * `extMethod` / `extNotification` fallbacks.
 */
export function createAcpAgentApp(getServer: () => AcpServer): AgentApp {
  return agent({ name: 'kimi-code-acp' })
    .onRequest(methods.agent.initialize, (ctx) => getServer().initialize(ctx.params))
    .onRequest(methods.agent.authenticate, (ctx) => getServer().authenticate(ctx.params))
    .onRequest(methods.agent.logout, (ctx) => getServer().logout(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => getServer().newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => getServer().loadSession(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => getServer().resumeSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => getServer().listSessions(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => getServer().closeSession(ctx.params))
    .onRequest(methods.agent.session.delete, (ctx) => getServer().deleteSession(ctx.params))
    .onRequest(methods.agent.session.fork, (ctx) => getServer().unstable_forkSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => getServer().setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      getServer().setSessionConfigOption(ctx.params),
    )
    .onRequest(methods.agent.session.prompt, (ctx) => getServer().prompt(ctx.params, ctx.signal))
    .onNotification(methods.agent.session.cancel, (ctx) => getServer().cancel(ctx.params))
    .onRequest(SET_SESSION_MODEL_METHOD, parseSetSessionModelParams, (ctx) =>
      getServer().setSessionModel(ctx.params),
    );
}

/**
 * Apply the optional `session/list` cwd filter to wire {@link SessionSummary}s.
 *
 * `cwd === undefined` means no filter (the adapter treats the schema-allowed
 * `null` sentinel the same way — the caller normalizes it before calling).
 * When a filter IS active, summaries that carry no `cwd` at all (sessions
 * persisted before the field existed) are KEPT: their workspace is unknown,
 * not known-different, and silently dropping them would make those sessions
 * unreachable from any cwd-filtered listing. The filter lives here (not in
 * the engine query) because the engine's `sessions.list` has no cwd predicate
 * — `workspaceIds` is its only workspace-level filter, and a raw cwd string is
 * not a workspace id.
 */
export function filterSessionSummariesByCwd(
  items: readonly SessionSummary[],
  cwd: string | undefined,
): readonly SessionSummary[] {
  if (cwd === undefined) return items;
  return items.filter((s) => s.cwd === undefined || s.cwd === cwd);
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

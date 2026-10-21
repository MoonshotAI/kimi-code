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
import { ErrorCodes, isError2 } from '@moonshot-ai/agent-core-v2';
import { RPCError } from '@moonshot-ai/klient';

import type { AcpClient } from './acp-client';
import type { IAcpConnection } from './acp-fs';
import { buildTerminalAuthMethod, TERMINAL_AUTH_METHOD } from './auth-methods';
import { acpMcpServersToConfigRecord } from './convert';
import { log } from './log';
import { isAcpModeId } from './modes';
import { AcpSession } from './session';
import { negotiateVersion } from './version';

const SESSION_NOT_FOUND_CODE = 40404;

function isSessionNotFound(error: unknown): boolean {
  return (
    (error instanceof RPCError && error.code === SESSION_NOT_FOUND_CODE) ||
    (isError2(error) && error.code === ErrorCodes.SESSION_NOT_FOUND)
  );
}

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
  readonly agentInfo?: Implementation;
  readonly disableAuth?: boolean;
  readonly terminalAuthEnv?: Readonly<Record<string, string>>;
  readonly terminalAuthLegacyCommand?: string;
  readonly resolveOriginalsDir?: (sessionId: string) => string | undefined;
  readonly bindSessionRuntime?: (sessionId: string) => Promise<void>;
  readonly unbindSessionRuntime?: (sessionId: string) => Promise<void>;
  readonly slashCommands?: SlashCommandsResolver;
}

export class AcpServer {
  private clientCapabilities: ClientCapabilities | undefined;
  private readonly agentInfo: Implementation | undefined;
  private readonly disableAuth: boolean;
  private readonly terminalAuthEnv: Readonly<Record<string, string>> | undefined;
  private readonly terminalAuthLegacyCommand: string | undefined;
  private readonly resolveOriginalsDir: ((sessionId: string) => string | undefined) | undefined;
  private readonly bindSessionRuntime: ((sessionId: string) => Promise<void>) | undefined;
  private readonly unbindSessionRuntime: ((sessionId: string) => Promise<void>) | undefined;
  private readonly resolveSlashCommands: (
    session: SessionHandle,
  ) => Promise<ReadonlyArray<AvailableCommand> | SlashCommandsSnapshot>;
  private readonly sessions = new Map<string, AcpSession>();

  constructor(
    private readonly conn: AcpClient,
    private readonly klient: Klient,
    private readonly acpConnection: IAcpConnection,
    opts: AcpServerOptions = {},
  ) {
    this.agentInfo = opts.agentInfo;
    this.disableAuth = opts.disableAuth ?? false;
    this.terminalAuthEnv = opts.terminalAuthEnv;
    this.terminalAuthLegacyCommand = opts.terminalAuthLegacyCommand;
    this.resolveOriginalsDir = opts.resolveOriginalsDir;
    this.bindSessionRuntime = opts.bindSessionRuntime;
    this.unbindSessionRuntime = opts.unbindSessionRuntime;
    const slashCommands = opts.slashCommands;
    this.resolveSlashCommands =
      typeof slashCommands === 'function'
        ? async (session) => slashCommands(session)
        : async () => slashCommands ?? [];
  }

  get clientCaps(): ClientCapabilities | undefined {
    return this.clientCapabilities;
  }

  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities;
    this.acpConnection.bindFsCapabilities(params.clientCapabilities?.fs);
    this.acpConnection.bindTerminalCapability(params.clientCapabilities?.terminal === true);
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
        fork: {},
        additionalDirectories: {},
      },
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
    const meta = await this.klient.global.sessions.create({
      workDir: params.cwd,
      additionalDirs: params.additionalDirectories,
      mcpServers: acpMcpServersToConfigRecord(params.mcpServers),
    });
    return { sessionId: meta.id, ...(await this.activateSession(meta.id)) };
  }

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
      if (isSessionNotFound(error)) {
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          `Unknown sessionId: ${params.sessionId}`,
        );
      }
      throw error;
    }
    const restored = await this.klient.session(forkedId).restore();
    if (!restored) {
      throw RequestError.invalidParams(
        { sessionId: forkedId },
        `Unknown sessionId: ${forkedId}`,
      );
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

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (acpSession !== undefined) {
      acpSession.dispose();
      this.sessions.delete(params.sessionId);
    }
    await this.klient.session(params.sessionId).close();
    await this.unbindSessionRuntime?.(params.sessionId);
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    try {
      await this.klient.session(params.sessionId).delete();
    } catch (error) {
      if (isSessionNotFound(error)) {
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
    await this.unbindSessionRuntime?.(params.sessionId);
    return {};
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    if (params.methodId !== 'login') {
      throw RequestError.invalidParams(
        { methodId: params.methodId },
        `Unknown auth method: ${params.methodId}`,
      );
    }
    await this.ensureAuthed();
  }

  async logout(_params: LogoutRequest): Promise<LogoutResponse | void> {
    await this.klient.global.auth.logout();
  }

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
      if (signal.aborted) onAbort();
      return await acpSession.prompt(params.prompt);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
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

  private async resumeAcpSession(
    sessionId: string,
    mcpServers?: SessionRestoreOptions['mcpServers'],
  ): Promise<AcpSession> {
    const restored = await this.klient.session(sessionId).restore({ mcpServers });
    if (!restored) {
      throw RequestError.invalidParams({ sessionId }, `Unknown sessionId: ${sessionId}`);
    }
    const acpSession = await this.wireSession(sessionId);
    this.sessions.get(sessionId)?.dispose();
    this.sessions.set(sessionId, acpSession);
    return acpSession;
  }

  private async wireSession(sessionId: string): Promise<AcpSession> {
    const session = this.klient.session(sessionId);
    await this.bindDefaultModel(session.agent('main'));
    await this.bindSessionRuntime?.(sessionId);
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

  private async activateSession(sessionId: string): Promise<{
    configOptions: Awaited<ReturnType<AcpSession['configOptions']>>;
    modes: ReturnType<AcpSession['modeState']>;
  }> {
    const acpSession = await this.wireSession(sessionId);
    this.sessions.set(sessionId, acpSession);
    this.scheduleAvailableCommandsUpdate(acpSession);
    return { configOptions: await acpSession.configOptions(), modes: acpSession.modeState() };
  }

  private scheduleAvailableCommandsUpdate(acpSession: AcpSession): void {
    setTimeout(() => {
      void acpSession.emitAvailableCommandsUpdate();
    }, 0);
  }

  private async bindDefaultModel(agent: AgentHandle): Promise<void> {
    try {
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

  private async ensureAuthed(): Promise<void> {
    if (this.disableAuth) return;
    try {
      await this.klient.global.auth.ensureReady();
      return;
    } catch (error) {
      log.info('acp: auth readiness probe failed, trying the OAuth summary', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const summaries = await this.klient.global.auth.summarize();
    if (!summaries.some((s) => s.loggedIn)) {
      throw RequestError.authRequired();
    }
  }

  private warnIgnoredAdditionalDirs(method: string, dirs: readonly string[] | undefined): void {
    if (dirs === undefined || dirs.length === 0) return;
    log.warn(`acp: ${method} ignores additionalDirectories (engine merges dirs only on create)`, {
      dirs,
    });
  }
}

const SET_SESSION_MODEL_METHOD = 'session/set_model';

export interface SetSessionModelParams {
  readonly sessionId: string;
  readonly modelId: string;
}

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

export function filterSessionSummariesByCwd(
  items: readonly SessionSummary[],
  cwd: string | undefined,
): readonly SessionSummary[] {
  if (cwd === undefined) return items;
  return items.filter((s) => s.cwd === undefined || s.cwd === cwd);
}

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

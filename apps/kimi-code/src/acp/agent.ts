import { isAbsolute, resolve } from 'node:path';

import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AgentCapabilities,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionModelState,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import { KimiHarness, log, type SessionSummary } from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeHostIdentity } from '#/cli/version';

import {
  authenticateAcpMethod,
  createAuthMethods,
  requireAcpAuthReady,
} from './auth-adapter';
import { toAcpRequestError, toAcpSetModelRequestError } from './errors';
import { acpMcpServersToKimiConfig } from './mcp-adapter';
import {
  createAcpModelConfigOptions,
  MODEL_CONFIG_OPTION_ID,
} from './model-adapter';
import { KimiAcpSession } from './session';

export interface KimiAcpAgentOptions {
  readonly connection: AgentSideConnection;
  readonly version: string;
  readonly harness?: KimiHarness;
}

type KimiAgentCapabilities = AgentCapabilities & {
  readonly sessionCapabilities: NonNullable<AgentCapabilities['sessionCapabilities']> & {
    readonly configOptions: Record<string, never>;
  };
};

export class KimiAcpAgent implements Agent {
  private readonly harness: KimiHarness;
  private readonly sessions = new Map<string, KimiAcpSession>();

  constructor(private readonly options: KimiAcpAgentOptions) {
    this.harness =
      options.harness ??
      new KimiHarness({
        identity: createKimiCodeHostIdentity(options.version),
        uiMode: 'acp',
      });
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion:
        params.protocolVersion === PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION,
      agentInfo: {
        name: 'kimi-code',
        title: 'Kimi Code',
        version: this.options.version,
      },
      agentCapabilities: createAgentCapabilities(),
      authMethods: createAuthMethods(params.clientCapabilities),
    };
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    await authenticateAcpMethod(this.harness, params.methodId);
    return {};
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    try {
      validateListSessionsRequest(params);
      await this.harness.ensureConfigFile();
      await requireAcpAuthReady(this.harness);
      const sessions = await this.harness.listSessions(
        { workDir: params.cwd ?? undefined },
      );
      return { sessions: sessions.map(acpSessionInfoFromSummary) };
    } catch (error) {
      throw toAcpRequestError(error);
    }
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    try {
      validateNewSessionRequest(params);
      await this.harness.ensureConfigFile();
      await requireAcpAuthReady(this.harness);
      const session = await this.harness.createSession({
        workDir: params.cwd,
        permission: 'manual',
        metadata: { acp: true },
        mcpServers: acpMcpServersToKimiConfig(params.mcpServers),
      });
      const acpSession = new KimiAcpSession(session, this.options.connection);
      this.sessions.set(acpSession.id, acpSession);
      const configuration = await this.sessionConfiguration(acpSession);
      return {
        sessionId: acpSession.id,
        ...configuration,
      };
    } catch (error) {
      throw toAcpRequestError(error);
    }
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse> {
    try {
      await this.getSession(params.sessionId).setModel(params.modelId);
      return {};
    } catch (error) {
      throw toAcpSetModelRequestError(error);
    }
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    try {
      if (params.configId !== MODEL_CONFIG_OPTION_ID) {
        throw RequestError.invalidParams(
          { configId: params.configId },
          `Unsupported session config option "${params.configId}".`,
        );
      }
      if (typeof params.value !== 'string') {
        throw RequestError.invalidParams(
          { configId: params.configId, value: params.value },
          'Model config option value must be a string.',
        );
      }

      const session = this.getSession(params.sessionId);
      await session.setModel(params.value);
      return {
        configOptions: await this.configOptions(session),
      };
    } catch (error) {
      throw toAcpSetModelRequestError(error);
    }
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    try {
      validateResumeSessionRequest(params);
      await this.harness.ensureConfigFile();
      await requireAcpAuthReady(this.harness);
      const summary = await this.findSessionSummary(params.sessionId);
      if (resolve(summary.workDir) !== resolve(params.cwd)) {
        throw RequestError.invalidParams(
          { cwd: params.cwd, sessionCwd: summary.workDir },
          'cwd must match the persisted session work directory',
        );
      }

      const existing = this.sessions.get(params.sessionId);
      if (existing !== undefined) {
        return await this.resumeResponse(existing);
      }

      const session = await this.harness.resumeSession({
        id: params.sessionId,
        mcpServers: acpMcpServersToKimiConfig(params.mcpServers ?? []),
      });
      const acpSession = new KimiAcpSession(session, this.options.connection);
      this.sessions.set(acpSession.id, acpSession);
      return await this.resumeResponse(acpSession);
    } catch (error) {
      throw toAcpRequestError(error);
    }
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    try {
      validateForkSessionRequest(params);
      await this.harness.ensureConfigFile();
      await requireAcpAuthReady(this.harness);
      const sourceSummary = await this.findSessionSummary(params.sessionId);
      if (resolve(sourceSummary.workDir) !== resolve(params.cwd)) {
        throw RequestError.invalidParams(
          { cwd: params.cwd, sessionCwd: sourceSummary.workDir },
          'cwd must match the source session work directory',
        );
      }

      const session = await this.harness.forkSession({
        id: params.sessionId,
        mcpServers: acpMcpServersToKimiConfig(params.mcpServers ?? []),
      });
      const acpSession = new KimiAcpSession(session, this.options.connection);
      this.sessions.set(acpSession.id, acpSession);
      const configuration = await this.sessionConfiguration(acpSession);
      return {
        sessionId: acpSession.id,
        ...configuration,
      };
    } catch (error) {
      throw toAcpRequestError(error);
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.getSession(params.sessionId).prompt(params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    await this.getSession(params.sessionId).cancel();
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.getSession(params.sessionId);
    await session.close();
    this.sessions.delete(params.sessionId);
    return {};
  }

  async close(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(
      sessions.map((session) =>
        session.close().catch((error: unknown) => {
          log.warn('acp session close failed', { sessionId: session.id, error });
        }),
      ),
    );
    await this.harness.close();
  }

  private getSession(sessionId: string): KimiAcpSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw RequestError.resourceNotFound(`session:${sessionId}`);
    }
    return session;
  }

  private async modelState(session: KimiAcpSession): Promise<SessionModelState | undefined> {
    const config = await this.harness.getConfig({ reload: true });
    return session.modelState(config);
  }

  private async configOptions(session: KimiAcpSession): Promise<SessionConfigOption[]> {
    return createAcpModelConfigOptions(await this.modelState(session));
  }

  private async sessionConfiguration(session: KimiAcpSession): Promise<{
    readonly models: SessionModelState | undefined;
    readonly configOptions: SessionConfigOption[];
  }> {
    const models = await this.modelState(session);
    return {
      models,
      configOptions: createAcpModelConfigOptions(models),
    };
  }

  private async resumeResponse(session: KimiAcpSession): Promise<ResumeSessionResponse> {
    return this.sessionConfiguration(session);
  }

  private async findSessionSummary(sessionId: string): Promise<SessionSummary> {
    const sessions = await this.harness.listSessions({ sessionId });
    const summary = sessions[0];
    if (summary === undefined) {
      throw RequestError.resourceNotFound(`session:${sessionId}`);
    }
    return summary;
  }
}

function createAgentCapabilities(): KimiAgentCapabilities {
  return {
    promptCapabilities: {
      image: true,
      embeddedContext: true,
    },
    mcpCapabilities: {
      http: true,
    },
    sessionCapabilities: {
      close: {},
      configOptions: {},
      fork: {},
      list: {},
      resume: {},
    },
  };
}

function validateListSessionsRequest(params: ListSessionsRequest): void {
  if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
    throw RequestError.invalidParams({ cwd: params.cwd }, 'cwd must be absolute');
  }

  if (params.cursor !== undefined && params.cursor !== null) {
    throw RequestError.invalidParams(
      { cursor: params.cursor },
      'session/list cursor pagination is not supported',
    );
  }
}

function validateNewSessionRequest(params: NewSessionRequest): void {
  validateSessionWorkDir(params.cwd);
  validateAdditionalDirectories(params.additionalDirectories);
}

function validateResumeSessionRequest(params: ResumeSessionRequest): void {
  validateSessionWorkDir(params.cwd);
  validateAdditionalDirectories(params.additionalDirectories);
}

function validateForkSessionRequest(params: ForkSessionRequest): void {
  validateSessionWorkDir(params.cwd);
  validateAdditionalDirectories(params.additionalDirectories);
}

function validateSessionWorkDir(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw RequestError.invalidParams({ cwd }, 'cwd must be absolute');
  }
}

function validateAdditionalDirectories(
  additionalDirectories: readonly string[] | undefined,
): void {
  if ((additionalDirectories?.length ?? 0) > 0) {
    throw RequestError.invalidParams(
      { additionalDirectories },
      'additionalDirectories are not supported',
    );
  }
}

function acpSessionInfoFromSummary(summary: SessionSummary): SessionInfo {
  return {
    sessionId: summary.id,
    cwd: summary.workDir,
    title: summary.title,
    updatedAt: new Date(summary.updatedAt).toISOString(),
  };
}

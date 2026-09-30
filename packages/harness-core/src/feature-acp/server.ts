import {
  RequestError,
  type AgentCapabilities,
  type AuthenticateRequest,
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
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import {
  MAIN_AGENT_ID,
  SessionSpaceError,
  useApp,
  useInject,
  type AppCommands,
  type CatalogModelBinding,
  type SessionHandle,
  type SessionRecord,
} from '@moonshot-ai/agent-core';

import { McpRef, type McpFacade } from '#/features/mcp/index';
import { WorkspaceRef, type WorkspacesFace } from '#/features/workspaces/index';

import { buildTerminalAuthMethod, TERMINAL_AUTH_METHOD } from './auth-methods';
import type { AcpClient } from './client';
import { acpMcpServersToConfigRecord } from './convert';
import { isAcpModeId } from './modes';
import type { AcpOsConnection } from './os-host';
import { wireAcpSession, type AcpSession } from './session';

export interface AcpHostOptions {
  readonly agentInfo?: Implementation;
  readonly disableAuth?: boolean;
  readonly terminalAuthEnv?: Readonly<Record<string, string>>;
  readonly terminalAuthLegacyCommand?: string;
  readonly onSessionActive?: (connection: AcpOsConnection) => void;
  readonly onSessionClose?: (sessionId: string) => void;
}

export interface AcpServerDeps {
  readonly ready: () => Promise<void>;
  readonly client: () => AcpClient;
  readonly models: () => readonly CatalogModelBinding[];
  readonly credentialProbe: () => boolean;
  readonly options: AcpHostOptions;
}

export interface AcpServerHandlers {
  readonly clientCapabilities: () => ClientCapabilities | undefined;
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse | void>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
  forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse>;
  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse>;
  closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse | void>;
  deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse>;
  prompt(params: PromptRequest, signal?: AbortSignal): Promise<PromptResponse>;
  cancel(params: CancelNotification): Promise<void>;
  setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void>;
  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse>;
  setSessionModel(params: { sessionId: string; modelId: string }): Promise<Record<string, unknown>>;
  notifySkillsChanged(): void;
  dispose(): void;
}

export function openAcpServer(deps: AcpServerDeps): AcpServerHandlers {
  let clientCapabilities: ClientCapabilities | undefined;
  const sessions = new Map<string, AcpSession>();
  const contributedMcpServers = new Map<string, { cwd: string; names: Set<string> }>();

  const probeMcp = (): McpFacade | undefined => useInject(McpRef).value;

  const probeWorkspaces = (): WorkspacesFace | undefined => useInject(WorkspaceRef).value;

  const connectSessionMcpServers = async (
    mcp: McpFacade | undefined,
    sessionId: string,
    cwd: string,
    servers: Parameters<typeof acpMcpServersToConfigRecord>[0],
  ): Promise<void> => {
    if (mcp === undefined) return;
    const configs = acpMcpServersToConfigRecord(servers);
    if (configs === undefined) return;
    const names = new Set<string>();
    for (const [name, config] of Object.entries(configs)) {
      await mcp.connect(name, config, { cwd });
      names.add(name);
    }
    const contributed = contributedMcpServers.get(sessionId);
    if (contributed === undefined) {
      contributedMcpServers.set(sessionId, { cwd, names });
      return;
    }
    for (const name of names) contributed.names.add(name);
  };

  const disconnectSessionMcpServers = async (
    mcp: McpFacade | undefined,
    sessionId: string,
  ): Promise<void> => {
    const contributed = contributedMcpServers.get(sessionId);
    contributedMcpServers.delete(sessionId);
    if (mcp === undefined || contributed === undefined) return;
    for (const name of contributed.names) {
      const stillUsed = [...contributedMcpServers.values()].some(
        (other) => other.cwd === contributed.cwd && other.names.has(name),
      );
      if (stillUsed) continue;
      await mcp.disconnect(name);
    }
  };

  const ensureAuthed = (): void => {
    if (deps.options.disableAuth === true) return;
    if (deps.credentialProbe()) return;
    throw RequestError.authRequired();
  };

  const elicitationForm = (): boolean =>
    Boolean(
      (clientCapabilities as { elicitation?: { form?: unknown } } | undefined)?.elicitation?.form,
    );

  const wireSession = (session: SessionHandle): AcpSession => {
    const fsRead = clientCapabilities?.fs?.readTextFile === true;
    const acpSession = wireAcpSession({
      client: deps.client(),
      session,
      agent: session.get(MAIN_AGENT_ID)!,
      models: deps.models,
      elicitationForm: elicitationForm(),
      readFile: fsRead
        ? async (path) => {
            try {
              const response = await deps
                .client()
                .readTextFile({ sessionId: session.sessionId, path });
              return response.content;
            } catch {
              return undefined;
            }
          }
        : undefined,
    });
    sessions.get(session.sessionId)?.dispose();
    sessions.set(session.sessionId, acpSession);
    return acpSession;
  };

  const activateSession = async (session: SessionHandle): Promise<AcpSession> => {
    if (session.get(MAIN_AGENT_ID) === undefined) {
      await session.create({ agentId: MAIN_AGENT_ID });
    }
    const acpSession = wireSession(session);
    deps.options.onSessionActive?.({
      sessionId: session.sessionId,
      client: deps.client(),
      fsReadTextFile: clientCapabilities?.fs?.readTextFile === true,
      fsWriteTextFile: clientCapabilities?.fs?.writeTextFile === true,
      terminalEnabled: clientCapabilities?.terminal === true,
    });
    scheduleAvailableCommandsUpdate(acpSession);
    return acpSession;
  };

  const scheduleAvailableCommandsUpdate = (acpSession: AcpSession): void => {
    setTimeout(() => {
      void acpSession.emitAvailableCommandsUpdate();
    }, 0);
  };

  const openExisting = async (app: AppCommands, sessionId: string): Promise<SessionHandle> => {
    try {
      return await app.open({ sessionId });
    } catch (error) {
      if (error instanceof SessionSpaceError) {
        throw RequestError.invalidParams({ sessionId }, `Unknown sessionId: ${sessionId}`);
      }
      throw error;
    }
  };

  const requireSession = (sessionId: string): AcpSession => {
    const acpSession = sessions.get(sessionId);
    if (acpSession === undefined) {
      throw RequestError.invalidParams({ sessionId }, `Unknown sessionId: ${sessionId}`);
    }
    return acpSession;
  };

  return {
    clientCapabilities: () => clientCapabilities,

    async initialize(params) {
      const mcp = probeMcp();
      clientCapabilities = params.clientCapabilities ?? undefined;
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
          fork: {},
          delete: {},
        },
        mcpCapabilities: mcp !== undefined ? { http: true, sse: true } : undefined,
      };
      const env = deps.options.terminalAuthEnv;
      const legacyCommand = deps.options.terminalAuthLegacyCommand;
      return {
        protocolVersion: 1,
        agentCapabilities,
        authMethods: [
          env !== undefined || legacyCommand !== undefined
            ? buildTerminalAuthMethod({ env, legacyCommand })
            : TERMINAL_AUTH_METHOD,
        ],
        agentInfo: deps.options.agentInfo,
      };
    },

    async authenticate(params) {
      await deps.ready();
      if (params.methodId !== 'login') {
        throw RequestError.invalidParams(
          { methodId: params.methodId },
          `Unknown auth method: ${params.methodId}`,
        );
      }
      ensureAuthed();
    },

    async newSession(params) {
      const app = useApp();
      const mcp = probeMcp();
      const workspaces = probeWorkspaces();
      await deps.ready();
      ensureAuthed();
      const session =
        workspaces !== undefined
          ? await workspaces.openSession(params.cwd, { metadata: { cwd: params.cwd } })
          : await app.open({ metadata: { cwd: params.cwd } });
      const acpSession = await activateSession(session);
      await connectSessionMcpServers(mcp, session.sessionId, params.cwd, params.mcpServers);
      return {
        sessionId: session.sessionId,
        configOptions: acpSession.configOptions(),
        modes: acpSession.modeState(),
      };
    },

    async loadSession(params) {
      const app = useApp();
      const mcp = probeMcp();
      await deps.ready();
      ensureAuthed();
      const session = await openExisting(app, params.sessionId);
      const acpSession = await activateSession(session);
      await connectSessionMcpServers(mcp, params.sessionId, params.cwd, params.mcpServers);
      await acpSession.replayHistory();
      return { configOptions: acpSession.configOptions(), modes: acpSession.modeState() };
    },

    async resumeSession(params) {
      const app = useApp();
      const mcp = probeMcp();
      await deps.ready();
      ensureAuthed();
      const session = await openExisting(app, params.sessionId);
      const acpSession = await activateSession(session);
      await connectSessionMcpServers(mcp, params.sessionId, params.cwd, params.mcpServers);
      return { configOptions: acpSession.configOptions(), modes: acpSession.modeState() };
    },

    async forkSession(params) {
      const app = useApp();
      await deps.ready();
      ensureAuthed();
      let session: SessionHandle;
      try {
        session = await app.open({ from: params.sessionId });
      } catch (error) {
        if (error instanceof SessionSpaceError) {
          throw RequestError.invalidParams(
            { sessionId: params.sessionId },
            `Unknown sessionId: ${params.sessionId}`,
          );
        }
        throw error;
      }
      const acpSession = await activateSession(session);
      return {
        sessionId: session.sessionId,
        configOptions: acpSession.configOptions(),
        modes: acpSession.modeState(),
      };
    },

    async listSessions(params) {
      const app = useApp();
      await deps.ready();
      const records = await app.space.list();
      const cwd = params.cwd ?? undefined;
      const items: SessionInfo[] = records
        .filter((record) => cwd === undefined || sessionCwd(record) === undefined || sessionCwd(record) === cwd)
        .map((record) => ({
          sessionId: record.id,
          cwd: sessionCwd(record) ?? '',
          title: record.title ?? null,
          updatedAt: null,
        }));
      return { sessions: items, nextCursor: null };
    },

    async closeSession(params) {
      const app = useApp();
      const mcp = probeMcp();
      await deps.ready();
      sessions.get(params.sessionId)?.dispose();
      sessions.delete(params.sessionId);
      deps.options.onSessionClose?.(params.sessionId);
      await app.close(params.sessionId);
      await disconnectSessionMcpServers(mcp, params.sessionId);
    },

    async deleteSession(params) {
      const app = useApp();
      const mcp = probeMcp();
      await deps.ready();
      try {
        await app.delete(params.sessionId);
      } catch (error) {
        if (error instanceof SessionSpaceError) {
          throw RequestError.invalidParams(
            { sessionId: params.sessionId },
            `Unknown sessionId: ${params.sessionId}`,
          );
        }
        throw error;
      }
      sessions.get(params.sessionId)?.dispose();
      sessions.delete(params.sessionId);
      deps.options.onSessionClose?.(params.sessionId);
      await disconnectSessionMcpServers(mcp, params.sessionId);
      return {};
    },

    async prompt(params, signal) {
      const acpSession = requireSession(params.sessionId);
      if (signal === undefined) {
        return acpSession.prompt(params.prompt);
      }
      const onAbort = (): void => {
        acpSession.cancel();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (signal.aborted) onAbort();
        return await acpSession.prompt(params.prompt);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },

    async cancel(params) {
      sessions.get(params.sessionId)?.cancel();
    },

    async setSessionMode(params) {
      const acpSession = requireSession(params.sessionId);
      if (!isAcpModeId(params.modeId)) {
        throw RequestError.invalidParams(
          { modeId: params.modeId },
          `Unknown modeId: ${params.modeId}`,
        );
      }
      await acpSession.setMode(params.modeId);
    },

    async setSessionConfigOption(params) {
      const acpSession = requireSession(params.sessionId);
      const value = (params as { value: unknown }).value;
      switch (params.configId) {
        case 'model':
          await acpSession.setModel(String(value));
          break;
        case 'thinking': {
          const accepted = await acpSession.setThinking(String(value));
          if (!accepted) {
            throw RequestError.invalidParams(
              { configId: params.configId, value },
              `Unknown thinking level: ${String(value)}`,
            );
          }
          break;
        }
        case 'mode': {
          if (!isAcpModeId(value)) {
            throw RequestError.invalidParams({ modeId: value }, `Unknown modeId: ${String(value)}`);
          }
          await acpSession.setMode(value);
          break;
        }
        default:
          throw RequestError.invalidParams(
            { configId: params.configId },
            `Unknown configId: ${params.configId}`,
          );
      }
      return { configOptions: acpSession.configOptions() };
    },

    async setSessionModel(params) {
      const acpSession = requireSession(params.sessionId);
      await acpSession.setModel(params.modelId);
      return {};
    },

    notifySkillsChanged() {
      for (const acpSession of sessions.values()) {
        void acpSession.emitAvailableCommandsUpdate();
      }
    },

    dispose() {
      for (const acpSession of sessions.values()) {
        acpSession.dispose();
      }
      sessions.clear();
    },
  };
}

function sessionCwd(record: SessionRecord): string | undefined {
  const cwd = record.metadata?.['cwd'];
  return typeof cwd === 'string' ? cwd : undefined;
}

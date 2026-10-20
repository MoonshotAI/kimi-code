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
import type { App } from '@moonshot-ai/agent-core/app/index';
import {
  SessionSpaceError,
  type Agent,
  type Session,
  type SessionRecord,
} from '@moonshot-ai/agent-core/session/index';

import type { ConfigStore } from '#/features/config/index';
import type { Interaction } from '#/features/interaction/index';
import type { McpFacade } from '#/features/mcp/index';
import type { CatalogModelBinding } from '#/features/provider-catalog/index';
import type { SkillCatalogFace } from '#/features/skill/index';
import type { WorkspacesFace } from '#/features/workspaces/index';

import { buildTerminalAuthMethod, TERMINAL_AUTH_METHOD } from './auth-methods';
import type { AcpClient } from './client';
import { acpMcpServersToConfigRecord } from './convert';
import { isAcpModeId } from './modes';
import type { AcpOsConnection } from './os-host';
import {
  wireAcpSession,
  type AcpAgentSlot,
  type AcpSession,
  type AcpSessionSlot,
} from './session';

export interface AcpHostOptions {
  readonly agentInfo?: Implementation;
  readonly disableAuth?: boolean;
  readonly terminalAuthEnv?: Readonly<Record<string, string>>;
  readonly terminalAuthLegacyCommand?: string;
  readonly onSessionActive?: (connection: AcpOsConnection) => void;
  readonly onSessionClose?: (sessionId: string) => void;
}

export interface AcpServerDeps {
  readonly app: App;
  readonly ready: () => Promise<void>;
  readonly client: () => AcpClient;
  readonly models: () => readonly CatalogModelBinding[];
  readonly credentialProbe: () => boolean;
  readonly mcp: () => McpFacade | undefined;
  readonly workspaces: () => WorkspacesFace | undefined;
  readonly skillCatalog: () => SkillCatalogFace | undefined;
  readonly config: () => ConfigStore | undefined;
  readonly agentSlot: (agent: Agent) => AcpAgentSlot | undefined;
  readonly sessionSlot: (session: Session) => AcpSessionSlot | undefined;
  readonly ensureMainAgent: (session: Session) => Promise<Agent>;
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
  trackMetaUpdated(sessionId: string, meta: SessionRecord): void;
  dispatchInteraction(sessionId: string, item: Interaction): void;
  dispose(): void;
}

export function openAcpServer(deps: AcpServerDeps): AcpServerHandlers {
  let clientCapabilities: ClientCapabilities | undefined;
  const sessions = new Map<string, AcpSession>();
  const contributedMcpServers = new Map<string, { cwd: string; names: Set<string> }>();

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

  const wireSession = async (session: Session, agent: Agent): Promise<AcpSession> => {
    const fsRead = clientCapabilities?.fs?.readTextFile === true;
    const acpSession = wireAcpSession({
      client: deps.client(),
      session,
      agent,
      models: deps.models,
      skillCatalog: deps.skillCatalog,
      mcp: deps.mcp,
      config: deps.config,
      slot: deps.agentSlot(agent),
      interactions: () => deps.sessionSlot(session)?.interactions.value,
      elicitationForm: elicitationForm(),
      readFile: fsRead
        ? async (path) => {
            try {
              const response = await deps
                .client()
                .readTextFile({ sessionId: session.id, path });
              return response.content;
            } catch {
              return undefined;
            }
          }
        : undefined,
      meta: await deps.app.space.get(session.id),
    });
    sessions.get(session.id)?.dispose();
    sessions.set(session.id, acpSession);
    return acpSession;
  };

  const activateSession = async (session: Session): Promise<AcpSession> => {
    const agent = await deps.ensureMainAgent(session);
    const acpSession = await wireSession(session, agent);
    deps.options.onSessionActive?.({
      sessionId: session.id,
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

  const openExisting = async (sessionId: string): Promise<Session> => {
    let record: SessionRecord | undefined;
    try {
      record = await deps.app.space.get(sessionId);
    } catch (error) {
      if (error instanceof SessionSpaceError) {
        throw RequestError.invalidParams({ sessionId }, `Unknown sessionId: ${sessionId}`);
      }
      throw error;
    }
    if (record === undefined) {
      throw RequestError.invalidParams({ sessionId }, `Unknown sessionId: ${sessionId}`);
    }
    return deps.app.create({ sessionId });
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
      const mcp = deps.mcp();
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
      await deps.ready();
      ensureAuthed();
      const workspaces = deps.workspaces();
      const session =
        workspaces !== undefined
          ? await workspaces.openSession(params.cwd, { metadata: { cwd: params.cwd } })
          : await deps.app.create({ metadata: { cwd: params.cwd } });
      const acpSession = await activateSession(session);
      await connectSessionMcpServers(deps.mcp(), session.id, params.cwd, params.mcpServers);
      return {
        sessionId: session.id,
        configOptions: acpSession.configOptions(),
        modes: acpSession.modeState(),
      };
    },

    async loadSession(params) {
      await deps.ready();
      ensureAuthed();
      const session = await openExisting(params.sessionId);
      const acpSession = await activateSession(session);
      await connectSessionMcpServers(deps.mcp(), params.sessionId, params.cwd, params.mcpServers);
      await acpSession.replayHistory();
      return { configOptions: acpSession.configOptions(), modes: acpSession.modeState() };
    },

    async resumeSession(params) {
      await deps.ready();
      ensureAuthed();
      const session = await openExisting(params.sessionId);
      const acpSession = await activateSession(session);
      await connectSessionMcpServers(deps.mcp(), params.sessionId, params.cwd, params.mcpServers);
      return { configOptions: acpSession.configOptions(), modes: acpSession.modeState() };
    },

    async forkSession(params) {
      await deps.ready();
      ensureAuthed();
      let session: Session;
      try {
        session = await deps.app.create({ from: params.sessionId });
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
        sessionId: session.id,
        configOptions: acpSession.configOptions(),
        modes: acpSession.modeState(),
      };
    },

    async listSessions(params) {
      await deps.ready();
      const records = await deps.app.space.list();
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
      await deps.ready();
      sessions.get(params.sessionId)?.dispose();
      sessions.delete(params.sessionId);
      deps.options.onSessionClose?.(params.sessionId);
      await deps.app.close(params.sessionId);
      await disconnectSessionMcpServers(deps.mcp(), params.sessionId);
    },

    async deleteSession(params) {
      await deps.ready();
      try {
        await deps.app.delete(params.sessionId);
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
      await disconnectSessionMcpServers(deps.mcp(), params.sessionId);
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

    trackMetaUpdated(sessionId, meta) {
      sessions.get(sessionId)?.metaUpdated(meta);
    },

    dispatchInteraction(sessionId, item) {
      sessions.get(sessionId)?.dispatchInteraction(item);
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

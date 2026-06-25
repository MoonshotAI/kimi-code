import { createDecorator } from '../../di';
import type { ClientTelemetryInfo, CoreRPC, JsonObject, SessionSummary } from '../../rpc';
import type { AgentRuntime } from '../agent';
import type { IAgentRPCService, ISessionRPCService } from '../agent/rpc/rpc';
import type { ICoreProcessService } from '../coreProcess/coreProcess';

export interface AgentRuntimeCreateSessionOptions {
  readonly id?: string | undefined;
  readonly workDir: string;
  readonly title?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly additionalDirs?: readonly string[] | undefined;
  readonly client?: ClientTelemetryInfo | undefined;
}

export interface AgentRuntimeForkSessionOptions {
  readonly sourceId: string;
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface IAgentRuntimeService {
  readonly _serviceBrand: undefined;

  createSession(options: AgentRuntimeCreateSessionOptions): Promise<SessionSummary>;
  forkSession(options: AgentRuntimeForkSessionOptions): Promise<SessionSummary>;
  get(sessionId: string, agentId?: string): Promise<AgentRuntime | undefined>;
  require(sessionId: string, agentId?: string): Promise<AgentRuntime>;
  getRPC(sessionId: string, agentId?: string): Promise<IAgentRPCService | undefined>;
  requireRPC(sessionId: string, agentId?: string): Promise<IAgentRPCService>;
  getSessionRPC(sessionId: string): Promise<ISessionRPCService | undefined>;
  requireSessionRPC(sessionId: string): Promise<ISessionRPCService>;
  getSessionSummary(sessionId: string): Promise<SessionSummary | undefined>;
  listSessionSummaries(options?: {
    readonly workDir?: string;
    readonly includeArchive?: boolean;
  }): Promise<readonly SessionSummary[]>;
  forget(sessionId: string, agentId?: string): Promise<void>;
}

export const IAgentRuntimeService =
  createDecorator<IAgentRuntimeService>('agentRuntimeService');

export class AgentRuntimeTodoError extends Error {
  constructor(
    readonly location: string,
    readonly logic: string,
  ) {
    super(`${location} is not migrated to services/agent. ${logic}`);
    this.name = 'AgentRuntimeTodoError';
  }
}

export type AgentRuntimeServiceSource =
  | IAgentRuntimeService
  | Pick<ICoreProcessService, 'rpc'>;

export function toAgentRuntimeService(
  source: AgentRuntimeServiceSource,
): IAgentRuntimeService {
  if (typeof (source as IAgentRuntimeService).requireRPC === 'function') {
    return source as IAgentRuntimeService;
  }
  return agentRuntimeServiceFromCoreProcess(source as Pick<ICoreProcessService, 'rpc'>);
}

export function agentRuntimeServiceFromCoreProcess(
  core: Pick<ICoreProcessService, 'rpc'>,
): IAgentRuntimeService {
  const resumed = new Set<string>();
  return {
    _serviceBrand: undefined,
    async createSession(options) {
      const summary = await core.rpc.createSession({
        id: options.id,
        workDir: options.workDir,
        model: options.model,
        thinking: options.thinking,
        metadata: options.metadata,
        additionalDirs: options.additionalDirs,
        client: options.client,
      });
      if (options.title !== undefined) {
        await core.rpc.renameSession({ sessionId: summary.id, title: options.title });
      }
      return summary;
    },
    async forkSession(options) {
      return core.rpc.forkSession({
        sessionId: options.sourceId,
        id: options.id,
        title: options.title,
        metadata: options.metadata,
      });
    },
    async get() {
      return undefined;
    },
    async require(sessionId: string, agentId = 'main') {
      throw new AgentRuntimeTodoError(
        'packages/agent-core/src/services/agentRuntime/agentRuntime.ts:require',
        `Runtime for session "${sessionId}" agent "${agentId}" is not available through services/agent.`,
      );
    },
    async getRPC(sessionId: string, agentId = 'main') {
      const summary = await this.getSessionSummary(sessionId);
      if (summary === undefined) return undefined;
      if (!resumed.has(sessionId)) {
        await core.rpc.resumeSession({ sessionId });
        resumed.add(sessionId);
      }
      return scopedAgentRPC(core.rpc, sessionId, agentId);
    },
    async requireRPC(sessionId: string, agentId = 'main') {
      const rpc = await this.getRPC(sessionId, agentId);
      if (rpc !== undefined) return rpc;
      throw new AgentRuntimeTodoError(
        'packages/agent-core/src/services/agentRuntime/agentRuntime.ts:requireRPC',
        `RPC for session "${sessionId}" agent "${agentId}" is not available through services/agent.`,
      );
    },
    async getSessionRPC(sessionId: string) {
      const summary = await this.getSessionSummary(sessionId);
      if (summary === undefined) return undefined;
      if (!resumed.has(sessionId)) {
        await core.rpc.resumeSession({ sessionId });
        resumed.add(sessionId);
      }
      return scopedSessionRPC(core.rpc, sessionId);
    },
    async requireSessionRPC(sessionId: string) {
      const rpc = await this.getSessionRPC(sessionId);
      if (rpc !== undefined) return rpc;
      throw new AgentRuntimeTodoError(
        'packages/agent-core/src/services/agentRuntime/agentRuntime.ts:requireSessionRPC',
        `Session RPC for session "${sessionId}" is not available through services/agent.`,
      );
    },
    async getSessionSummary(sessionId: string) {
      const all = await core.rpc.listSessions({});
      return all.find((summary) => summary.id === sessionId);
    },
    listSessionSummaries(options = {}) {
      return core.rpc.listSessions(options);
    },
    async forget(sessionId: string) {
      resumed.delete(sessionId);
    },
  };
}

function scopedAgentRPC(
  core: CoreRPC,
  sessionId: string,
  agentId: string,
): IAgentRPCService {
  return new Proxy({}, {
    get(_target, prop) {
      const method = core[prop as keyof CoreRPC];
      if (typeof method !== 'function') return undefined;
      return (payload: Record<string, unknown> = {}) =>
        method({ ...payload, sessionId, agentId } as never);
    },
  }) as IAgentRPCService;
}

function scopedSessionRPC(
  core: CoreRPC,
  sessionId: string,
): ISessionRPCService {
  return new Proxy({}, {
    get(_target, prop) {
      const method = core[prop as keyof CoreRPC];
      if (typeof method !== 'function') return undefined;
      return (payload: Record<string, unknown> = {}) =>
        method({ ...payload, sessionId } as never);
    },
  }) as ISessionRPCService;
}

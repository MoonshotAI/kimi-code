import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type {
  AgentRuntimeDefinition,
  AgentRuntimeSnapshot,
  RuntimeOf,
} from '#/agent/runtime/agentRuntime';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { BindAgentInput } from '#/agent/profile/profile';

export interface AgentScopeCreatedEvent {
  readonly context: AgentContext;
  readonly handle: IAgentScopeHandle;
}

export const MAIN_AGENT_ID = 'main';

export interface CreateAgentOptions {
  readonly agentId?: string;
  readonly binding?: BindAgentInput;
  readonly runtimeId?: string;
  readonly forkedFrom?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ForkAgentOptions {
  readonly agentId?: string;
  readonly binding?: Partial<BindAgentInput>;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface AgentListFilter {
  readonly prefix?: string;
}

export interface IAgentLifecycleService {
  readonly _serviceBrand: undefined;

  readonly onDidCreate: Event<AgentContext>;
  readonly onDidCreateScope: Event<AgentScopeCreatedEvent>;
  readonly onWillClose: Event<AgentContext>;
  readonly onDidClose: Event<AgentContext>;

  create(opts?: CreateAgentOptions): Promise<AgentContext>;

  fork(source: AgentContext, opts?: ForkAgentOptions): Promise<AgentContext>;

  get(agentId: string): AgentContext | undefined;
  list(filter?: AgentListFilter): readonly AgentContext[];
  resolve<Definition extends AgentRuntimeDefinition<any, any>>(
    agent: AgentContext,
    definition: Definition,
  ): RuntimeOf<Definition>;
  inspect(agent: AgentContext): AgentRuntimeSnapshot;
  broadcastPermissionMode(mode: PermissionMode): void;
  remove(agent: AgentContext): Promise<void>;

  handleOf(agentId: string): IAgentScopeHandle | undefined;

  adopt(handle: IAgentScopeHandle): AgentContext;

  attachRuntimes(agent: AgentContext): void;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');

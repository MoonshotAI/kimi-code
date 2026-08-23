import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
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
  readonly onDidDispose: Event<AgentContext>;

  create(opts?: CreateAgentOptions): Promise<IAgentScopeHandle>;

  fork(source: AgentContext, opts?: ForkAgentOptions): Promise<IAgentScopeHandle>;

  get(context: AgentContext): IAgentScopeHandle | undefined;
  findAgentHandle(agentId: string): IAgentScopeHandle | undefined;
  list(filter?: AgentListFilter): readonly IAgentScopeHandle[];
  broadcastPermissionMode(mode: PermissionMode): void;
  remove(context: AgentContext): Promise<void>;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');

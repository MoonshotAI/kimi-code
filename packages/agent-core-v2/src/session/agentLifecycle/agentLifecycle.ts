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
  /**
   * Identity labels recorded for the forked agent (persisted through
   * `ISessionMetadata.registerAgent` and seeded into its `IAgentScopeContext`).
   * Lets the creator mark the fork's kind — e.g. a spawned spine branch — so
   * Agent-scoped consumers can recognize it.
   */
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * When true, trim the trailing assistant message that carries tool calls from
   * the copied context history before it is appended to the forked agent. This
   * removes the in-flight tool-call carrier (e.g. `spine_spawn`) so the child
   * agent does not inherit an unfinished parent action as part of its context.
   * Only the last message is considered; if it has no tool calls it is left in
   * place. The remaining history still goes through the default trailing open
   * tool-exchange settlement before being appended.
   */
  readonly trimTrailingToolCallBatch?: boolean;
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

  /**
   * Transitional bridge to the compatibility Agent scope (removed in M6):
   * the scope handle for a live agent, or `undefined` when the agent is
   * unknown or already closing.
   */
  handleOf(agentId: string): IAgentScopeHandle | undefined;

  /**
   * Transitional bridge for hosts that materialize the compatibility Agent
   * scope out of band (removed in M6): registers an existing scope as a
   * managed agent, applying the registered runtime definitions. Durable
   * participants attach through `attachRuntimes` once the scope is fully
   * materialized. Returns the scope's `AgentContext`.
   */
  adopt(handle: IAgentScopeHandle): AgentContext;

  /**
   * Transitional bridge (removed in M6): attaches the agent's durable
   * runtime participants to its event dispatcher and, on the first call,
   * marks the agent active and fires `onDidCreate` / `onDidCreateScope`.
   * Must run before the dispatcher restores; idempotent.
   */
  attachRuntimes(agent: AgentContext): void;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { BindAgentInput } from '#/agent/profile/profile';

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
   * the copied context history before appending it to the forked agent. This
   * removes the in-flight tool-call carrier (e.g. `spine_spawn`) so the child
   * agent does not inherit an unfinished parent action as part of its context.
   * Only the last message is considered; if it has no tool calls it is left in
   * place. Default behavior (undefined/false) copies the history verbatim.
   */
  readonly trimTrailingToolCallBatch?: boolean;
}

export interface AgentListFilter {
  readonly prefix?: string;
}

export interface IAgentLifecycleService {
  readonly _serviceBrand: undefined;

  readonly onDidCreate: Event<IAgentScopeHandle>;
  readonly onDidDispose: Event<string>;

  create(opts?: CreateAgentOptions): Promise<IAgentScopeHandle>;

  fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle>;

  get(agentId: string): IAgentScopeHandle | undefined;
  list(filter?: AgentListFilter): readonly IAgentScopeHandle[];
  broadcastPermissionMode(mode: PermissionMode): void;
  remove(agentId: string): Promise<void>;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');

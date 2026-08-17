/**
 * `agentLifecycle` domain — flat registry of the session's agents.
 *
 * Owns agent *existence* — the creation pipeline (`create` / `fork`), the
 * registry (`get` / `list` / `remove`), and the lifecycle events — plus the
 * session-wide fan-outs only the live registry can reach
 * (`broadcastPermissionMode`). Session-scoped — one instance per session.
 *
 * Invariants:
 * - The registry is flat: agents have no nesting. There is no parent/child or
 *   caller/callee relationship here; when a business domain needs such a
 *   relationship (e.g. the `Agent` tool's display events), that domain
 *   maintains it itself.
 * - No agent id is special: the main agent is an ordinary agent whose only
 *   distinction is the conventional `MAIN_AGENT_ID`, and nothing in this
 *   domain branches on it.
 * - Creation is single-flight per explicit agent id (concurrent creations
 *   join), an already-created agent is returned as-is, and a failed bootstrap
 *   drops the incomplete handle.
 * - `forkedFrom` is provenance only (a recorded value); business logic must
 *   not branch on it.
 */

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

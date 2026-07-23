/**
 * `agentLifecycle` domain (L6) — flat registry of the session's agents.
 *
 * Owns agent *existence* — the creation pipeline (`create` / `fork`), the
 * registry (`get` / `list` / `remove`), and the lifecycle events — plus the
 * session-wide fan-outs only the live registry can reach
 * (`broadcastPermissionMode`). Driving turns on an agent — and the hook/event
 * surface those runs announce — lives in the `subagent` domain; session-level
 * MCP lives in the `sessionMcp` domain. Session-scoped — one instance per
 * session.
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

/** The conventional id of the session's main agent. */
export const MAIN_AGENT_ID = 'main';

export interface CreateAgentOptions {
  readonly agentId?: string;
  readonly binding?: BindAgentInput;
  /** Agent this one is derived from (provenance only; not used by business logic). */
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

  /** Fires after an agent is created and registered, with its scope handle. */
  readonly onDidCreate: Event<IAgentScopeHandle>;
  /** Fires after an agent is removed, with its agent id. */
  readonly onDidDispose: Event<string>;

  /**
   * Create an agent from zero (empty context), ready to admit turns.
   *
   * For an explicit `agentId` this is create-or-get: a concurrent in-flight
   * creation for the same id is joined (never a duplicate scope), and an
   * already-created agent is returned as-is — callers always receive a fully
   * bootstrapped handle (activity lane `idle`). Auto-minted ids (no
   * `agentId`) always create fresh.
   */
  create(opts?: CreateAgentOptions): Promise<IAgentScopeHandle>;

  /**
   * Fork an agent: copy its profile binding and context history into a new
   * agent, recording `forkedFrom = sourceAgentId`. Throws when the source does
   * not exist, and when an explicit target `agentId` is already taken (a fork
   * must never silently overwrite an existing agent's binding/context).
   */
  fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle>;

  /** Look up a live agent by id. The handle is visible while its creation is still in flight. */
  get(agentId: string): IAgentScopeHandle | undefined;
  list(filter?: AgentListFilter): readonly IAgentScopeHandle[];
  /**
   * Set the permission mode on every live agent in the session. Session-level
   * mode switches (a `setPermission` call on the main agent, the legacy
   * `agent_config.permission_mode` patch) fan out through here so
   * already-running subagents observe the change; each agent still journals
   * its own `permission.set_mode` op.
   */
  broadcastPermissionMode(mode: PermissionMode): void;
  /** Drive an agent through disposal (reject new turns, drain, release the scope). */
  remove(agentId: string): Promise<void>;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');

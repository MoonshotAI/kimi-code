/**
 * `/api/v1/debug` dispatcher — resolves the scope + Service + method from a request
 * and calls it. No facade: Services are reached directly through the scope
 * tree, the channel registry decides which Services are exposed at all, and the
 * method is invoked by reflection (VS Code's `ProxyChannel.fromService` model).
 */

import {
  ErrorCodes,
  IAgentGoalService,
  IAgentLifecycleService,
  ISessionLifecycleService,
  Error2,
  type IScopeHandle,
  type Scope,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';

import type { ScopeKind } from './channel';
import { resolveAnyScopedServiceId } from './channelRegistry';
import { assertSerializable } from './errors';
import { MAIN_AGENT_ID, ensureMainAgent } from './mainAgent';

/**
 * Channel name → identifier resolution used to gate which Services are
 * reachable. The single RPC surface (`/api/v1/debug`) resolves against the
 * full scoped DI registry (default).
 */
export type ChannelLookup = (name: string) => ServiceIdentifier<unknown> | undefined;

/**
 * Resolve the scope a request targets. Throws `Error2` when the referenced
 * session or agent does not exist — `session.not_found` for a missing session,
 * `agent.not_found` when the session exists but the agent scope is not
 * materialized (e.g. a subagent created before the last server restart or
 * session close: its metadata registry entry and wire log persist, but
 * `resume` only re-materializes the main agent).
 */
export async function resolveScope(
  core: Scope,
  scopeKind: ScopeKind,
  params: Record<string, string>,
): Promise<Scope | IScopeHandle> {
  switch (scopeKind) {
    case 'core':
      return core;
    case 'session': {
      const sessionId = params['session_id'] ?? '';
      const session = core.accessor.get(ISessionLifecycleService).get(sessionId);
      if (session === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} not found`);
      }
      return session;
    }
    case 'agent': {
      const sessionId = params['session_id'] ?? '';
      const agentId = params['agent_id'] ?? '';
      const session = core.accessor.get(ISessionLifecycleService).get(sessionId);
      if (session === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} not found`);
      }
      if (agentId === MAIN_AGENT_ID) return ensureMainAgent(session);
      const agent = session.accessor.get(IAgentLifecycleService).get(agentId);
      if (agent === undefined) {
        throw new Error2(
          ErrorCodes.AGENT_NOT_FOUND,
          `agent ${agentId} not found in session ${sessionId}`,
        );
      }
      return agent;
    }
  }
}

/**
 * Dispatch one call. Throws `Error2` for expected failures (unknown service,
 * scope not found, service not in scope, method missing); the route maps them
 * to the envelope. Unexpected errors propagate and become `50001`.
 */
export async function resolveService(
  core: Scope,
  scopeKind: ScopeKind,
  params: Record<string, string>,
  serviceName: string,
  lookup: ChannelLookup = resolveAnyScopedServiceId,
): Promise<object> {
  const scope = await resolveScope(core, scopeKind, params);
  if (scope === undefined) {
    throw new Error2(
      ErrorCodes.SESSION_NOT_FOUND,
      `session ${params['session_id'] ?? ''} not found`,
    );
  }
  const id = lookup(serviceName);
  if (id === undefined) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `unknown service: ${serviceName}`);
  }
  if (
    scopeKind === 'agent' &&
    id === IAgentGoalService &&
    params['agent_id'] !== MAIN_AGENT_ID
  ) {
    throw new Error2(
      ErrorCodes.GOAL_UNSUPPORTED_AGENT,
      'Goals are only supported by the main agent',
      { details: { agentId: params['agent_id'] ?? '' } },
    );
  }
  try {
    return scope.accessor.get(id) as object;
  } catch {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `service not available in ${scopeKind} scope: ${serviceName}`,
    );
  }
}

export async function dispatch(
  core: Scope,
  scopeKind: ScopeKind,
  params: Record<string, string>,
  serviceName: string,
  method: string,
  arg: unknown,
  lookup: ChannelLookup = resolveAnyScopedServiceId,
): Promise<unknown> {
  const service = await resolveService(core, scopeKind, params, serviceName, lookup);
  const member = (service as Record<string, unknown>)[method];
  if (member === undefined) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `method not found: ${serviceName}.${method}`);
  }

  // Property read (e.g. `mode`, `rules`, `isActive`) — return as-is.
  if (typeof member !== 'function') {
    return assertSerializable(member);
  }

  const args = Array.isArray(arg) ? arg : arg === undefined ? [] : [arg];
  const result = await (member as (...a: unknown[]) => unknown).apply(service, args);
  return assertSerializable(result);
}

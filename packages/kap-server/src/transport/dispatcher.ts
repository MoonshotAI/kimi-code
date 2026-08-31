import {
  ErrorCodes,
  IAgentLifecycleService,
  Error2,
  getLiveSessionById,
  type IScopeHandle,
  type Scope,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';

import type { ScopeKind } from './channel';
import { resolveAnyScopedServiceId } from './channelRegistry';
import { assertSerializable } from './errors';
import { MAIN_AGENT_ID, ensureMainAgent } from './mainAgent';

export type ChannelLookup = (name: string) => ServiceIdentifier<unknown> | undefined;

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
      const session = getLiveSessionById(core.accessor, sessionId);
      if (session === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} not found`);
      }
      return session;
    }
    case 'agent': {
      const sessionId = params['session_id'] ?? '';
      const agentId = params['agent_id'] ?? '';
      const session = getLiveSessionById(core.accessor, sessionId);
      if (session === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} not found`);
      }
      if (agentId === MAIN_AGENT_ID) return ensureMainAgent(session);
      const agent = session.accessor.get(IAgentLifecycleService).handleOf(agentId);
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

export async function resolveService(
  core: Scope,
  scopeKind: ScopeKind,
  params: Record<string, string>,
  serviceName: string,
  lookup: ChannelLookup = (name) => resolveAnyScopedServiceId(core, name),
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
  lookup: ChannelLookup = (name) => resolveAnyScopedServiceId(core, name),
): Promise<unknown> {
  const service = await resolveService(core, scopeKind, params, serviceName, lookup);
  const member = (service as Record<string, unknown>)[method];
  if (member === undefined) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `method not found: ${serviceName}.${method}`);
  }

  if (typeof member !== 'function') {
    return assertSerializable(member);
  }

  const args = Array.isArray(arg) ? arg : arg === undefined ? [] : [arg];
  const result = await (member as (...a: unknown[]) => unknown).apply(service, args);
  return assertSerializable(result);
}

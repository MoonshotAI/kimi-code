import {
  ErrorCodes,
  IAgentLifecycleService,
  Error2,
  agentContextOf,
  getLiveSessionById,
  type ContentPart,
  type IAgentScopeHandle,
  type IScopeHandle,
  type PromptSubmitResult,
  type Scope,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';
import { AgentPrompt } from '@moonshot-ai/agent-core-v2/features/prompt/promptAgentRuntime';

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

interface PromptSubmitWirePayload {
  readonly input: readonly ContentPart[];
  readonly disabledTools?: readonly string[];
  readonly promptId?: string;
}

function promptLaunchWireResult(result: PromptSubmitResult): { turn_id: number } | undefined {
  return result.turnId === undefined ? undefined : { turn_id: result.turnId };
}

function agentPromptServiceView(agent: IAgentScopeHandle): object {
  const prompt = () =>
    agent.accessor.get(IAgentLifecycleService).resolve(agentContextOf(agent), AgentPrompt);
  return {
    submit: async (payload: PromptSubmitWirePayload) =>
      promptLaunchWireResult(
        await prompt().submit({
          content: payload.input,
          origin: { kind: 'user' },
          promptId: payload.promptId,
          disabledTools: payload.disabledTools,
        }),
      ),
    submitSteer: async (payload: { readonly input: readonly ContentPart[] }) =>
      promptLaunchWireResult(
        await prompt().submit({
          content: payload.input,
          origin: { kind: 'user' },
          admission: 'currentTurn',
        }),
      ),
  };
}

export async function resolveService(
  core: Scope,
  scopeKind: ScopeKind,
  params: Record<string, string>,
  serviceName: string,
  lookup: ChannelLookup = (name) => resolveAnyScopedServiceId(core, name),
): Promise<object> {
  const scope = await resolveScope(core, scopeKind, params);
  if (serviceName === 'agentPromptService') {
    if (scopeKind !== 'agent') {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `service not available in ${scopeKind} scope: ${serviceName}`,
      );
    }
    return agentPromptServiceView(scope as IAgentScopeHandle);
  }
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

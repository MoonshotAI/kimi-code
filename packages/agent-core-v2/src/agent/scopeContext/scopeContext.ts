import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { AgentSpaceImpl } from '#/agent/agentContext/agentSpace';

export interface IAgentScopeContext {
  readonly _serviceBrand: undefined;

  readonly agentId: string;
  readonly forkedFrom?: string;
  readonly agentContext: AgentContext;
  scope(subKey?: string): string;
}

export const IAgentScopeContext: ServiceIdentifier<IAgentScopeContext> =
  createDecorator<IAgentScopeContext>('agentScopeContext');

export function makeAgentScopeContext(input: {
  readonly agentId: string;
  readonly agentScope: string;
  readonly forkedFrom?: string;
  readonly generation?: number;
}): IAgentScopeContext {
  const { agentScope } = input;
  const space = new AgentSpaceImpl(input.agentId);
  const agentContext: AgentContext = Object.freeze({
    agentId: input.agentId,
    generation: input.generation ?? 0,
    space,
  });
  space._bindContext(agentContext);
  return {
    _serviceBrand: undefined,
    agentId: input.agentId,
    forkedFrom: input.forkedFrom,
    agentContext,
    scope: (subKey?: string): string => {
      if (subKey === undefined || subKey === '') return agentScope;
      if (agentScope === '') return subKey;
      return `${agentScope}/${subKey}`;
    },
  };
}

export function agentContextOfScope(scope: IAgentScopeContext): AgentContext {
  return scope.agentContext;
}

export function agentContextOf(handle: IAgentScopeHandle): AgentContext {
  return agentContextOfScope(handle.accessor.get(IAgentScopeContext));
}

export function tryAgentContextOf(handle: IAgentScopeHandle): AgentContext | undefined {
  return handle.accessor.get(IAgentScopeContext)?.agentContext;
}

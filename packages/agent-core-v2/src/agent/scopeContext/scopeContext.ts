import type { AgentContext } from '#/agent/agentContext/agentContext';

export interface IAgentScopeContext {
  readonly _serviceBrand: undefined;

  readonly agentId: string;
  readonly forkedFrom?: string;
  readonly agentContext: AgentContext;
  scope(subKey?: string): string;
}

export function makeAgentScopeContext(input: {
  readonly agentId: string;
  readonly agentScope: string;
  readonly forkedFrom?: string;
  readonly generation?: number;
}): IAgentScopeContext {
  const { agentScope } = input;
  const agentContext: AgentContext = Object.freeze({
    agentId: input.agentId,
    generation: input.generation ?? 0,
  });
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

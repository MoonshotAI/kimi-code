import { collection } from '#/_base/di/collection';
import type { AgentContext } from '#/agent/agentContext/agentContext';

import type { DomainResourceRuntime } from './agentModel';

export interface AgentEffectContext {
  readonly agent: AgentContext;
}

export interface AgentEffectDefinition<
  Context extends AgentEffectContext = AgentEffectContext,
  Runtime extends DomainResourceRuntime = DomainResourceRuntime,
> {
  readonly id: string;
  readonly create: (context: Context) => Runtime;
}

export function defineAgentEffect<
  Context extends AgentEffectContext,
  Runtime extends DomainResourceRuntime,
>(
  definition: AgentEffectDefinition<Context, Runtime>,
): AgentEffectDefinition<Context, Runtime> {
  return Object.freeze(definition);
}

export const AgentEffectContribution = collection<AgentEffectDefinition<any, any>>(
  'agent-effect',
  {
    validate: (value, existing) => {
      if (existing.some((definition) => definition.id === value.id)) {
        throw new Error(`Agent effect '${value.id}' already has an active provider`);
      }
    },
  },
);

export interface SessionEffectContext {
  readonly sessionId: string;
}

export interface SessionEffectDefinition<
  Runtime extends DomainResourceRuntime = DomainResourceRuntime,
> {
  readonly id: string;
  readonly create: (context: SessionEffectContext) => Runtime;
}

export const SessionEffectContribution = collection<SessionEffectDefinition>('session-effect', {
  validate: (value, existing) => {
    if (existing.some((definition) => definition.id === value.id)) {
      throw new Error(`Session effect '${value.id}' already has an active provider`);
    }
  },
});

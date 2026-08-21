import type {
  ActorLogic,
  AnyActorRef,
  Snapshot,
} from 'xstate';

import { collection } from '#/_base/di/collection';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { registerEvent2Class, type Event2, type Event2Class } from '#/app/event/event2';
import type { StateFold } from '#/state/state';

export type AgentRuntimeStatus = 'registered' | 'materialized' | 'done' | 'failed' | 'retired';

export interface AgentRuntimeIdentity {
  readonly agentId: string;
  readonly generation: number;
}

export interface AgentRuntimeContext<State> {
  readonly agent: AgentContext;
  get<T>(id: ServiceIdentifier<T>): T;
  getState(): State;
  dispatch(event: Event2<any>): Promise<void>;
  track<T>(work: Promise<T>): Promise<T>;
  readonly onDidChange: Event<State>;
}

export interface AgentRuntimeDurableDefinition<State> {
  readonly events: readonly Event2Class<any, any>[];
  readonly undoable: boolean;
  readonly transition: StateFold<State>;
  read(snapshot: Snapshot<unknown>): State;
  commit(actor: AnyActorRef, state: State): void;
}

export interface AgentRuntimeDefinition<State, Facade> {
  readonly id: string;
  readonly logic: ActorLogic<any, any, any>;
  readonly input?: (agent: AgentContext) => unknown;
  readonly durable?: AgentRuntimeDurableDefinition<State>;
  readonly createFacade: (
    actor: AnyActorRef,
    context: AgentRuntimeContext<State>,
  ) => Facade;
  readonly activate?: (
    actor: AnyActorRef,
    context: AgentRuntimeContext<State>,
  ) => void;
  readonly inspect?: (snapshot: Snapshot<unknown>) => unknown;
}

export function defineAgentRuntime<State, Facade>(
  definition: AgentRuntimeDefinition<State, Facade>,
): AgentRuntimeDefinition<State, Facade> {
  for (const cls of definition.durable?.events ?? []) registerEvent2Class(cls);
  return Object.freeze(definition);
}

export interface AgentCapability<T> {
  readonly id: string;
  readonly _type?: T;
}

export function defineAgentCapability<T>(id: string): AgentCapability<T> {
  return Object.freeze({ id });
}

export interface AgentRuntimeContribution {
  readonly capability: AgentCapability<any>;
  readonly definition: AgentRuntimeDefinition<any, any>;
}

export const AgentRuntimeContributionPoint = collection<AgentRuntimeContribution>(
  'agent-runtime',
  {
    validate: (value, existing) => {
      if (existing.some((item) => item.capability.id === value.capability.id)) {
        throw new Error(`Agent runtime capability '${value.capability.id}' already has an active provider`);
      }
      if (existing.some((item) => item.definition.id === value.definition.id)) {
        throw new Error(`Agent runtime '${value.definition.id}' already has an active provider`);
      }
    },
  },
);

export interface AgentRuntimeDefinitionRecord {
  readonly capability: AgentCapability<any>;
  readonly definition: AgentRuntimeDefinition<any, any>;
  readonly generation: number;
  active: boolean;
}

export interface AgentRuntimeContributionSnapshot {
  readonly id: string;
  readonly generation: number;
  readonly status: AgentRuntimeStatus;
  readonly state?: unknown;
  readonly error?: string;
}

export interface AgentRuntimeSnapshot {
  readonly identity: AgentRuntimeIdentity;
  readonly contributions: readonly AgentRuntimeContributionSnapshot[];
}

export interface DurableAgentRuntimeParticipant<State = any> {
  readonly id: string;
  readonly events: readonly Event2Class<any, any>[];
  readonly undoable: boolean;
  readonly transition: StateFold<State>;
  getState(): State;
  commit(state: State): void;
}

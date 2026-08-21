import type {
  ActorLogic,
  AnyActorRef,
  Snapshot,
} from 'xstate';

import { collection } from '#/_base/di/collection';
import type { IDisposable } from '#/_base/di/lifecycle';
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
  own(resource: IDisposable | (() => void | Promise<void>)): void;
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

export const AgentRuntimeLifecycle = Symbol('agentRuntimeLifecycle');

export interface AgentRuntimeLifecycle {
  start?(): void;
  dispose?(): void | Promise<void>;
}

export interface AgentRuntimeDefinition<State, Runtime> {
  readonly id: string;
  readonly logic: ActorLogic<any, any, any>;
  readonly input?: (agent: AgentContext) => unknown;
  readonly durable?: AgentRuntimeDurableDefinition<State>;
  readonly eager?: boolean;
  readonly create: (context: AgentRuntimeContext<State>) => Runtime;
  readonly inspect?: (snapshot: Snapshot<unknown>) => unknown;
}

export type RuntimeOf<Definition> =
  Definition extends AgentRuntimeDefinition<any, infer Runtime> ? Runtime : never;

export function defineAgentRuntime<State, Runtime>(
  definition: AgentRuntimeDefinition<State, Runtime>,
): AgentRuntimeDefinition<State, Runtime> {
  for (const cls of definition.durable?.events ?? []) registerEvent2Class(cls);
  return Object.freeze(definition);
}

export const AgentRuntimeContributionPoint = collection<AgentRuntimeDefinition<any, any>>(
  'agent-runtime',
  {
    validate: (value, existing) => {
      if (existing.some((item) => item.id === value.id)) {
        throw new Error(`Agent runtime '${value.id}' already has an active provider`);
      }
    },
  },
);

export interface AgentRuntimeDefinitionRecord {
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

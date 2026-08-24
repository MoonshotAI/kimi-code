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
  getLogicState<T>(): T;
  dispatch(event: Event2<any>): Promise<void>;
  send(event: unknown): void;
  readonly onDidChange: Event<State>;
}

export interface AgentRuntimeRestoreEvent {
  readonly type: 'runtime.restore';
  waitUntil(work: Promise<unknown>): void;
}

export interface AgentRuntimeDurableDefinition<State> {
  readonly events: readonly Event2Class<any, any>[];
  readonly undoable: boolean;
  readonly transition: StateFold<State>;
  read(snapshot: Snapshot<unknown>): State;
  commit(actor: AnyActorRef, state: State): void;
}

const runtimeType = Symbol('agentRuntimeType');

export interface AgentRuntimeDefinition<StateOrRuntime, Runtime = StateOrRuntime> {
  readonly [runtimeType]: Runtime;
}

export interface AgentRuntimeDescriptor<State, Runtime> {
  readonly id: string;
  readonly logic: ActorLogic<any, any, any>;
  readonly input?: unknown;
  readonly durable?: AgentRuntimeDurableDefinition<State>;
  readonly eager?: boolean;
  readonly createApi: (context: AgentRuntimeContext<State>) => Runtime;
  readonly inspect?: (snapshot: Snapshot<unknown>) => unknown;
}

export interface AgentRuntimeProvider<Runtime> {
  readonly contract: AgentRuntimeDefinition<Runtime>;
}

const descriptors = new WeakMap<object, AgentRuntimeDescriptor<any, any>>();
const definitionIds = new WeakMap<object, string>();

export type RuntimeOf<Definition> =
  Definition extends AgentRuntimeDefinition<any, infer Runtime> ? Runtime : never;

export function defineAgentRuntimeContract<Runtime>(id: string): AgentRuntimeDefinition<Runtime> {
  const definition = Object.freeze({}) as AgentRuntimeDefinition<Runtime>;
  definitionIds.set(definition, id);
  return definition;
}

export function defineAgentRuntimeProvider<State, Runtime>(
  contract: AgentRuntimeDefinition<Runtime>,
  descriptor: AgentRuntimeDescriptor<State, Runtime>,
): AgentRuntimeProvider<Runtime> {
  for (const cls of descriptor.durable?.events ?? []) registerEvent2Class(cls);
  const provider = Object.freeze({ contract }) as AgentRuntimeProvider<Runtime>;
  descriptors.set(provider, descriptor);
  return provider;
}

export function getAgentRuntimeDefinitionId(
  definition: AgentRuntimeDefinition<any>,
): string {
  const id = definitionIds.get(definition);
  if (id === undefined) throw new Error('Unknown agent runtime definition');
  return id;
}

export function getAgentRuntimeDescriptor(
  provider: AgentRuntimeProvider<any>,
): AgentRuntimeDescriptor<any, any> {
  const descriptor = descriptors.get(provider);
  if (descriptor === undefined) throw new Error('Unknown agent runtime provider');
  return descriptor;
}

export type AgentRuntimeContribution = AgentRuntimeProvider<any>;

const validateRuntimeContribution = (value: AgentRuntimeContribution, existing: readonly AgentRuntimeContribution[]): void => {
  const id = getAgentRuntimeDefinitionId(value.contract);
  if (existing.some((item) => getAgentRuntimeDefinitionId(item.contract) === id)) {
    throw new Error(`Agent runtime '${id}' already has an active provider`);
  }
};

export const AgentRuntimeContributionPoint = collection<AgentRuntimeContribution>(
  'agent-runtime',
  { validate: validateRuntimeContribution },
);

export const AgentRuntimeOverrideContributionPoint = collection<AgentRuntimeContribution>(
  'agent-runtime-override',
  { validate: validateRuntimeContribution },
);

export interface AgentRuntimeDefinitionRecord {
  readonly definition: AgentRuntimeDefinition<any>;
  readonly provider: AgentRuntimeProvider<any>;
  readonly generation: number;
  readonly providerGeneration?: number;
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

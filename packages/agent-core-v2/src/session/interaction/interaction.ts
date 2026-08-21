import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { defineAgentCapability } from '#/agent/runtime/agentRuntime';

export type InteractionKind = 'approval' | 'question' | 'user_tool';

export interface InteractionOrigin {
  readonly agentId?: string;
  readonly turnId?: number;
}

export interface InteractionRequest<TPayload = unknown> {
  readonly id?: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly origin?: InteractionOrigin;
}

export interface Interaction<TPayload = unknown> {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly origin: InteractionOrigin;
  readonly createdAt: number;
}

export interface InteractionResolution {
  readonly id: string;
  readonly response: unknown;
}

export interface InteractionPendingChangedEvent {
  readonly pending: readonly string[];
}

export interface IAgentInteraction {
  readonly _serviceBrand: undefined;

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse>;
  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction;
  respond(id: string, response: unknown): boolean;
  listPending(kind?: InteractionKind): readonly Interaction[];
  isRecentlyResolved(id: string): boolean;
  cancelPendingForTurn(turnId: number): void;
  readonly onDidChangePending: Event<InteractionPendingChangedEvent>;
  readonly onDidResolve: Event<InteractionResolution>;
}

export const IAgentInteraction = createDecorator<IAgentInteraction>('agentInteraction');

export const AgentInteraction = defineAgentCapability<IAgentInteraction>('interaction');

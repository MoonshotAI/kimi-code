/**
 * `interaction` domain (L6) — blocking human-in-the-loop request kernel.
 *
 * Defines the `Interaction` model and the `ISessionInteractionService` kernel that
 * owns the session's pending interaction set: a unified, blocking request /
 * response primitive (`request` → `respond`) with change notification
 * (`onDidChangePending`), a non-blocking enqueue (`enqueue`) for callers that observe
 * the outcome through the `onDidResolve` stream, and a `listPending` view.
 * `approval`, `question`, and user-tool execution are typed specializations
 * layered on top of this kernel; the kernel itself is domain-agnostic.
 * Session-scoped — the pending set is keyed by session and dies with it.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

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

export interface ISessionInteractionService {
  readonly _serviceBrand: undefined;

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse>;
  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction;
  respond(id: string, response: unknown): void;
  listPending(kind?: InteractionKind): readonly Interaction[];
  isRecentlyResolved(id: string): boolean;
  cancelPendingForTurn(turnId: number): void;
  readonly onDidChangePending: Event<InteractionPendingChangedEvent>;
  readonly onDidResolve: Event<InteractionResolution>;
}

export const ISessionInteractionService: ServiceIdentifier<ISessionInteractionService> =
  createDecorator<ISessionInteractionService>('sessionInteractionService');

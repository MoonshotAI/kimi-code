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

export type InteractionCancellationReason = 'turn_ended' | 'agent_closed';

export interface InteractionCancellation {
  readonly cancelled: true;
  readonly reason: InteractionCancellationReason;
}

export function isInteractionCancellation(response: unknown): response is InteractionCancellation {
  if (typeof response !== 'object' || response === null) return false;
  const value = response as { readonly cancelled?: unknown; readonly reason?: unknown };
  return value.cancelled === true && (value.reason === 'turn_ended' || value.reason === 'agent_closed');
}

export interface InteractionResolution {
  readonly id: string;
  readonly response: unknown;
}

export interface InteractionPendingChangedEvent {
  readonly pending: readonly string[];
}


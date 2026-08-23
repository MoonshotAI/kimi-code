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


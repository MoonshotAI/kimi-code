import type { EffectScope } from '@vue/reactivity';

export interface Token<T> {
  readonly key?: string;
  readonly type?: T;
}

export interface CollectionToken<T> {
  readonly key?: string;
  readonly type?: T;
}

export function createToken<T>(key?: string): Token<T> {
  return { key };
}

export function createCollection<T>(key?: string): CollectionToken<T> {
  return { key };
}

export interface DurableSlice {
  readonly name: string;
  readonly initialState: () => unknown;
  readonly reducers: Record<string, (draft: any, event: any) => unknown>;
}

export interface DurableBackend {
  registerSlice(slice: DurableSlice): Promise<() => void>;
  dispatch(event: { type: string } & Record<string, unknown>): Promise<unknown>;
  subscribe(listener: (state: unknown) => void): () => void;
  getState(): unknown;
}

export const EventStoreService = createToken<DurableBackend>('kernel.eventStore');

export const NodeEnrichment = createToken<Record<string, unknown>>('kernel.nodeEnrichment');

export const AgentScope = createToken<EffectScope>('kernel.agentScope');

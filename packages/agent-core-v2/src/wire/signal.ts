/**
 * `wire` domain (L2) — augmentable `SignalMap` and the `Signal` discriminated
 * union for transient notifications.
 *
 * Signals are a side channel on `IWireService`, separate from the Model → Op
 * state machine: `wire.signal(signal)` broadcasts without an OpGroup. Domains
 * declare their signal payloads by augmenting `SignalMap` via `declare module`;
 * `Signal` resolves to a `{ type } & payload` union over those declarations.
 * Durability classification (volatile vs durable) lives in the server consumer,
 * not here. Scope-agnostic.
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SignalMap {}

export type Signal<K extends keyof SignalMap = keyof SignalMap> = {
  [T in K]: { readonly type: T } & Readonly<SignalMap[T]>;
}[K];

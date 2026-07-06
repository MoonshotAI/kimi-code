/**
 * `event` domain (L1) — augmentable `DomainEventMap`, the `DomainEvent`
 * discriminated union, and the `IEventBus` contract (the single "what happened"
 * channel) plus its DI token.
 *
 * `IEventBus` is the canonical fact bus: producers `publish(event)` and
 * consumers `subscribe(handler)` (all events) or `subscribe(type, handler)`
 * (one type). It sits beside the legacy `IEventService` (`./event`), which is
 * kept only until Phase 3 cuts its consumers over and deletes it; new code uses
 * `IEventBus`. Domains declare their event payloads by augmenting
 * `DomainEventMap` via `declare module '#/app/event/eventBus'`; `DomainEvent`
 * resolves to a `{ type } & payload` union over those declarations — the same
 * distributed-declaration shape as `SignalMap` (`#/wire/signal`). Durability
 * classification (volatile vs durable) lives in the server consumer, not here.
 * App-scope singleton; scope-agnostic contract.
 */

import { createDecorator, type IDisposable, type ServiceIdentifier } from '#/_base/di';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DomainEventMap {}

export type DomainEvent<K extends keyof DomainEventMap = keyof DomainEventMap> = {
  [T in K]: { readonly type: T } & Readonly<DomainEventMap[T]>;
}[K];

export interface IEventBus {
  readonly _serviceBrand: undefined;

  publish(event: DomainEvent): void;
  subscribe(handler: (event: DomainEvent) => void): IDisposable;
  subscribe<K extends keyof DomainEventMap>(
    type: K,
    handler: (event: DomainEvent<K>) => void,
  ): IDisposable;
}

export const IEventBus: ServiceIdentifier<IEventBus> = createDecorator<IEventBus>('eventBus');

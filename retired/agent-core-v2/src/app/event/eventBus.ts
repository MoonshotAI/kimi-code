/**
 * `event` domain (L1) — augmentable `DomainEventMap`, the `DomainEvent`
 * discriminated union, and the `IEventBus` contract (the per-agent "what
 * happened" channel) plus its DI token.
 *
 * `IEventBus` is the canonical fact bus for agent events: producers
 * `publish(event)` and consumers `subscribe(handler)` (all events) or
 * `subscribe(type, handler)` (one type). It is bound at Agent scope — one
 * instance per agent — so a subscription sees only that agent's events (the
 * server fans out per agent and tags `agentId` / `sessionId`). Process-global events (model catalog,
 * session lifecycle, auth) stay on the legacy `IEventService` (`./event`),
 * which is retained as the global channel; its payload type is re-exported from
 * the barrel as `GlobalEvent`. Domains declare their agent-event shapes by
 * augmenting `DomainEventMap` via `declare module '#/app/event/eventBus'`;
 * `DomainEvent` resolves to the map entry intersected with the key-derived
 * `{ type }`, so domains can register either payload-only shapes or complete
 * protocol event types. Durability classification (volatile vs durable) lives
 * in the server consumer, not here. Agent-scope; scope-agnostic contract.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DomainEventMap {}

export type DomainEvent<K extends keyof DomainEventMap = keyof DomainEventMap> = {
  [T in K]: Readonly<{ readonly type: T } & DomainEventMap[T]>;
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

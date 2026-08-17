/**
 * `event` domain — the `IEventBus` contract (the per-agent "what happened"
 * channel) plus its DI token.
 *
 * `IEventBus` is the canonical fact bus for agent events: every published
 * fact is an `Event2` subclass instance carrying its `type`, payload fields,
 * and `time`. Producers go through the Agent-scope event dispatcher
 * (`IEventDispatcher.dispatch`), which publishes here after folds commit;
 * consumers `subscribe(handler)` (all events), `subscribe(EventClass,
 * handler)` (one event class), or `subscribe(type, handler)` (one type
 * string, backing the unit `on(...)` string form). It is bound at Agent
 * scope — one instance per agent — so a subscription sees only that agent's
 * events (the server fans out per agent and tags `agentId` / `sessionId`).
 * Process-global events (model catalog, session lifecycle, auth) stay on the
 * App-scope `IEventService`. Agent-scope; scope-agnostic contract.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';

import type { Event2, Event2Class } from './event2';

export interface IEventBus {
  readonly _serviceBrand: undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publish(event: Event2<any>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe(handler: (event: Event2<any>) => void): IDisposable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe<P, E extends Event2<P>>(cls: Event2Class<P, E>, handler: (event: E) => void): IDisposable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe(type: string, handler: (event: Event2<any>) => void): IDisposable;
}

export const IEventBus: ServiceIdentifier<IEventBus> = createDecorator<IEventBus>('eventBus');

/**
 * `debugEvents` domain — `IDebugEventsService`: event-subscription
 * introspection.
 *
 * Public contract. `subscriptions()` merges two sides: the precise unit-book
 * side (every materialized unit's ledger entries whose label marks an event
 * subscription — `on:<name>` from a named `Emitter` or the fiber `on`
 * capability, `disposable:EventSubscription` from an unnamed emitter) and the
 * emitter-side fallback (listener counts of every materialized `IEventBus`
 * instance and the global `IEventService`), which also covers subscriptions
 * the caller never registered on a unit book. Unmaterialized on-demand units
 * and anonymous fiber units are not enumerable and are simply absent.
 * Contributed at App scope through `DebugEventsFeature` — reachable over the
 * debug RPC surface through the contributed-service fallback, but absent from
 * the static scoped registry (`GET /api/v1/debug/channels`). All payloads are
 * JSON-serializable wire data.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { LedgerEntryInfo } from '#/_base/lifecycle/ledger';

export interface DebugEventSubscription {
  readonly scopePath: string;
  readonly unit: string;
  readonly uid?: number;
  readonly label: string;
  readonly kind: LedgerEntryInfo['kind'];
}

export interface DebugEventBusSnapshot {
  readonly scopePath: string;
  readonly all: number;
  readonly perType: Record<string, number>;
}

export interface DebugEventSubscriptions {
  readonly subscriptions: DebugEventSubscription[];
  readonly buses: DebugEventBusSnapshot[];
  readonly globalListeners?: number;
}

export interface IDebugEventsService {
  readonly _serviceBrand: undefined;

  subscriptions(): DebugEventSubscriptions;
}

export const IDebugEventsService = createDecorator<IDebugEventsService>('debugEventsService');

/**
 * `debugEvents` domain — `IDebugEventsService` implementation.
 *
 * Read-only introspection over the kernel's debug accessors (`children` /
 * `servicesSnapshot` / `fiberHost.materializedInstance` / unit-book
 * `ledger.entries`), plus listener counters on the `event` domain's bus
 * implementations; no kernel state is mutated. Instances resolve up the parent
 * chain, so each is attributed to the first container that reaches it and
 * deduplicated by identity; unmaterialized on-demand units read as `undefined`
 * and are skipped. Contributed at App scope through `DebugEventsFeature`; the
 * injected container is the tree root.
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import type { LedgerEntryInfo } from '#/_base/lifecycle/ledger';
import { IEventService } from '#/app/event/event';
import { IEventBus } from '#/app/event/eventBus';
import { walkScopeContainers } from '#/debug/scopeTree';

import {
  IDebugEventsService,
  type DebugEventBusSnapshot,
  type DebugEventSubscription,
  type DebugEventSubscriptions,
} from './debugEvents';

interface UnitBookOwner {
  readonly unitBook: { entries(): LedgerEntryInfo[] };
}

interface BusCountSource {
  listenerCounts(): { all: number; perType: Record<string, number> };
}

interface GlobalCountSource {
  readonly listenerCount: number;
}

export class DebugEventsService implements IDebugEventsService {
  declare readonly _serviceBrand: undefined;

  private readonly root: InstantiationService;

  constructor(@IInstantiationService instantiation: IInstantiationService) {
    this.root = instantiation as InstantiationService;
  }

  subscriptions(): DebugEventSubscriptions {
    const subscriptions: DebugEventSubscription[] = [];
    const buses: DebugEventBusSnapshot[] = [];
    const seenUnits = new Set<object>();
    const seenBuses = new Set<object>();
    for (const info of walkScopeContainers(this.root)) {
      for (const registration of info.container.servicesSnapshot()) {
        const id = info.container.findIdentifier(registration.token);
        if (id === undefined) {
          continue;
        }
        const instance: unknown = info.container.fiberHost.materializedInstance(id);
        if (typeof instance !== 'object' || instance === null || seenUnits.has(instance)) {
          continue;
        }
        seenUnits.add(instance);
        if ('unitBook' in instance) {
          collectEventEntries((instance as UnitBookOwner).unitBook.entries(), subscriptions, {
            scopePath: info.path,
            unit: registration.token,
            uid: registration.uid,
          });
        }
      }
      const bus: unknown = info.container.fiberHost.materializedInstance(IEventBus);
      if (isBusCountSource(bus) && !seenBuses.has(bus)) {
        seenBuses.add(bus);
        buses.push({ scopePath: info.path, ...bus.listenerCounts() });
      }
    }
    const globalEvents: unknown = this.root.fiberHost.materializedInstance(IEventService);
    const globalListeners = isGlobalCountSource(globalEvents)
      ? globalEvents.listenerCount
      : undefined;
    return { subscriptions, buses, globalListeners };
  }
}

function collectEventEntries(
  entries: readonly LedgerEntryInfo[],
  out: DebugEventSubscription[],
  base: { scopePath: string; unit: string; uid?: number },
): void {
  for (const entry of entries) {
    if (isEventSubscriptionLabel(entry.label)) {
      out.push({ ...base, label: entry.label, kind: entry.kind });
    }
    if (entry.children !== undefined) {
      collectEventEntries(entry.children, out, base);
    }
  }
}

function isEventSubscriptionLabel(label: string): boolean {
  return label.startsWith('on:') || label === 'disposable:EventSubscription';
}

function isBusCountSource(value: unknown): value is BusCountSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BusCountSource).listenerCounts === 'function'
  );
}

function isGlobalCountSource(value: unknown): value is GlobalCountSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as GlobalCountSource).listenerCount === 'number'
  );
}

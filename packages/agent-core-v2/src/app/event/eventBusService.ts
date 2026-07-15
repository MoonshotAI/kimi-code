/**
 * `event` domain (L1) — `IEventBus` implementation.
 *
 * Delivers published events through the `_base/event` `Emitter` primitive: one
 * full-stream emitter for `subscribe(handler)` and a lazily-created per-type
 * emitter for `subscribe(type, handler)`, so a type with no subscribers costs
 * nothing on `publish`. `publish` fires the full stream first, then the
 * per-type emitter (if any), preserving producer order within a single
 * synchronous dispatch. Bound at Agent scope as an `Eager` singleton; the
 * companion `IEventService` (`./eventService`) stays registered until Phase 3.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';

import { type DomainEvent, type DomainEventMap, IEventBus } from './eventBus';

export class EventBusService extends Disposable implements IEventBus {
  declare readonly _serviceBrand: undefined;

  private readonly allEmitter = this._register(new Emitter<DomainEvent>());
  private readonly perType = new Map<keyof DomainEventMap, Emitter<DomainEvent>>();

  publish(event: DomainEvent): void {
    this.allEmitter.fire(event);
    this.perType.get(event.type)?.fire(event);
  }

  subscribe(handler: (event: DomainEvent) => void): IDisposable;
  subscribe<K extends keyof DomainEventMap>(
    type: K,
    handler: (event: DomainEvent<K>) => void,
  ): IDisposable;
  subscribe<K extends keyof DomainEventMap>(
    typeOrHandler: K | ((event: DomainEvent) => void),
    handler?: (event: DomainEvent<K>) => void,
  ): IDisposable {
    if (typeof typeOrHandler === 'function') {
      return this.allEmitter.event(typeOrHandler);
    }
    const type = typeOrHandler;
    let emitter = this.perType.get(type);
    if (emitter === undefined) {
      emitter = this._register(new Emitter<DomainEvent>());
      this.perType.set(type, emitter);
    }
    return emitter.event(handler as unknown as (event: DomainEvent) => void);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IEventBus,
  EventBusService,
  InstantiationType.Eager,
  'event',
);

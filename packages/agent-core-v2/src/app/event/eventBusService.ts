/**
 * `event` domain — `IEventBus` implementation.
 *
 * Delivers published events through the `Emitter` primitive: one
 * full-stream emitter for `subscribe(handler)` and a lazily-created per-type
 * emitter for `subscribe(type, handler)`, so a type with no subscribers costs
 * nothing on `publish`. `publish` fires the full stream first, then the
 * per-type emitter (if any), preserving producer order within a single
 * synchronous dispatch. Bound at Agent scope and constructed when the scope is
 * created.
 */

import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';

import { type DomainEvent, type DomainEventMap, IEventBus } from './eventBus';

export class EventBusService extends Service implements IEventBus {
  declare readonly _serviceBrand: undefined;

  private readonly allEmitter = this._register(new Emitter<DomainEvent>('*'));
  private readonly perType = new Map<keyof DomainEventMap, Emitter<DomainEvent>>();

  publish(event: DomainEvent): void {
    this.allEmitter.fire(event);
    this.perType.get(event.type)?.fire(event);
  }

  listenerCounts(): { all: number; perType: Record<string, number> } {
    const perType: Record<string, number> = {};
    for (const [type, emitter] of this.perType) {
      perType[String(type)] = emitter.listenerCount;
    }
    return { all: this.allEmitter.listenerCount, perType };
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
      emitter = this._register(new Emitter<DomainEvent>(String(type)));
      this.perType.set(type, emitter);
    }
    return emitter.event(handler as unknown as (event: DomainEvent) => void);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IEventBus,
  EventBusService,
  ScopeActivation.OnScopeCreated,
  'event',
);

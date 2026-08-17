/**
 * `event` domain — `IEventBus` implementation.
 *
 * Delivers published `Event2` instances through the `Emitter` primitive: one
 * full-stream emitter for `subscribe(handler)` and a lazily-created per-type
 * emitter for `subscribe(EventClass | type, handler)`, so a type with no
 * subscribers costs nothing on `publish`. `publish` fires the full stream
 * first, then the per-type emitter (if any), preserving producer order within
 * a single synchronous dispatch. Bound at Agent scope and constructed when
 * the scope is created.
 */

import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';

import type { Event2, Event2Class } from './event2';
import { IEventBus } from './eventBus';

export class EventBusService extends Service implements IEventBus {
  declare readonly _serviceBrand: undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly allEmitter = this._register(new Emitter<Event2<any>>('*'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly perType = new Map<string, Emitter<Event2<any>>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publish(event: Event2<any>): void {
    this.allEmitter.fire(event);
    this.perType.get(event.type)?.fire(event);
  }

  listenerCounts(): { all: number; perType: Record<string, number> } {
    const perType: Record<string, number> = {};
    for (const [type, emitter] of this.perType) {
      perType[type] = emitter.listenerCount;
    }
    return { all: this.allEmitter.listenerCount, perType };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe(handler: (event: Event2<any>) => void): IDisposable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe<P, E extends Event2<P>>(
    cls: Event2Class<P, E>,
    handler: (event: E) => void,
  ): IDisposable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe(type: string, handler: (event: Event2<any>) => void): IDisposable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeOrHandler: string | Event2Class<any, any> | ((event: Event2<any>) => void),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler?: (event: Event2<any>) => void,
  ): IDisposable {
    if (typeof typeOrHandler === 'function' && !('type' in typeOrHandler)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return this.allEmitter.event(typeOrHandler as (event: Event2<any>) => void);
    }
    const type = typeof typeOrHandler === 'string' ? typeOrHandler : typeOrHandler.type;
    let emitter = this.perType.get(type);
    if (emitter === undefined) {
      emitter = this._register(new Emitter<Event2<any>>(type));
      this.perType.set(type, emitter);
    }
    return emitter.event(handler!);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IEventBus,
  EventBusService,
  ScopeActivation.OnScopeCreated,
  'event',
);

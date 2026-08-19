import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';

import type { Event2, Event2Class } from './event2';
import { IEventBus } from './eventBus';

export class EventBusService extends Service implements IEventBus {
  declare readonly _serviceBrand: undefined;

  private readonly allEmitter = this._register(new Emitter<Event2<any>>('*'));
  private readonly perType = new Map<string, Emitter<Event2<any>>>();

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

  subscribe(handler: (event: Event2<any>) => void): IDisposable;
  subscribe<P, E extends Event2<P>>(
    cls: Event2Class<P, E>,
    handler: (event: E) => void,
  ): IDisposable;
  subscribe(type: string, handler: (event: Event2<any>) => void): IDisposable;
  subscribe(
    typeOrHandler: string | Event2Class<any, any> | ((event: Event2<any>) => void),
    handler?: (event: Event2<any>) => void,
  ): IDisposable {
    if (typeof typeOrHandler === 'function' && !('type' in typeOrHandler)) {
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

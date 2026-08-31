import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';

import { IEventService } from './event';
import type { Event2 } from './event2';

export class EventService extends Service implements IEventService {
  declare readonly _serviceBrand: undefined;

  private readonly emitter = this._register(new Emitter<Event2<any>>('publish'));
  readonly onDidPublish: Event<Event2<any>> = this.emitter.event;

  get listenerCount(): number {
    return this.emitter.listenerCount;
  }

  publish(event: Event2<any>): void {
    this.emitter.fire(event);
  }

  subscribe(handler: (event: Event2<any>) => void): IDisposable {
    return this.emitter.event(handler);
  }
}

registerScopedService(
  LifecycleScope.App,
  IEventService,
  EventService,
  ScopeActivation.OnScopeCreated,
  'event',
);

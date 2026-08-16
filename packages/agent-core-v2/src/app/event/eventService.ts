/**
 * `event` domain — `IEventService` implementation.
 *
 * Delivers published events to subscribers through the `Emitter` primitive.
 * Bound at App scope.
 */

import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';

import { type DomainEvent, IEventService } from './event';

export class EventService extends Service implements IEventService {
  declare readonly _serviceBrand: undefined;

  private readonly emitter = this._register(new Emitter<DomainEvent>('publish'));
  readonly onDidPublish: Event<DomainEvent> = this.emitter.event;

  get listenerCount(): number {
    return this.emitter.listenerCount;
  }

  publish(event: DomainEvent): void {
    this.emitter.fire(event);
  }

  subscribe(handler: (event: DomainEvent) => void): IDisposable {
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

/**
 * `event` domain (L0) — `IEventService` implementation.
 *
 * Delivers published events to subscribers through the `_base/event` `Emitter`
 * primitive. Bound at App scope.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';

import { type DomainEvent, IEventService } from './event';

export class EventService extends Disposable implements IEventService {
  declare readonly _serviceBrand: undefined;

  private readonly emitter = this._register(new Emitter<DomainEvent>());
  readonly onDidPublish: Event<DomainEvent> = this.emitter.event;

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
  InstantiationType.Eager,
  'event',
);

/**
 * `event` domain (L7) — `IEventService` implementation.
 *
 * Core-scope pub-sub. `publish` fan-outs to all subscribers whose filter
 * matches; `subscribe` returns a disposable that unregisters the listener.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IDisposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { type ProtocolEvent, IEventService } from './event';

type Listener = (event: ProtocolEvent) => void;

export class EventService implements IEventService {
  declare readonly _serviceBrand: undefined;
  private readonly listeners = new Set<Listener>();

  publish(event: ProtocolEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(handler: (event: ProtocolEvent) => void): IDisposable {
    this.listeners.add(handler);
    return toDisposable(() => {
      this.listeners.delete(handler);
    });
  }
}

registerScopedService(LifecycleScope.Core, IEventService, EventService, InstantiationType.Delayed, 'event');

/**
 * `EventService` — implementation of `IEventService`.
 *
 * Pure in-process pub-sub: a thin wrapper over `Emitter<Event>`. No
 * sessionId extraction, no per-session sequence numbers, no ring buffer, no
 * WS fan-out — those daemon transport concerns live in
 * `@moonshot-ai/server/services/WSBroadcastService`, which subscribes to this
 * bus via `onDidPublish` and handles the broadcast/replay machinery.
 *
 * Listener exceptions route to `onUnexpectedError` inside `Emitter.fire()`
 * (per agent-core's `Emitter` contract). We do NOT wrap individual handlers.
 *
 * Publishing after `dispose()` is a no-op.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { Emitter } from '../../base/common/event';
import type { Event as ProtocolEvent } from '@moonshot-ai/protocol';

import { IEventService } from './event';

export class EventService extends Disposable implements IEventService {
  readonly _serviceBrand: undefined;

  /**
   * VSCode-style Emitter. Owned via `_register` so it disposes when the
   * service is torn down. Listener exceptions route to `onUnexpectedError`
   * inside `Emitter.fire()`.
   */
  private readonly _onDidPublish = this._register(new Emitter<ProtocolEvent>());
  readonly onDidPublish = this._onDidPublish.event;

  publish(event: ProtocolEvent): void {
    if (this._store.isDisposed) return;
    this._onDidPublish.fire(event);
  }
}

// Self-register under the global singleton registry. No ctor args — the
// service has no dependencies.
registerSingleton(IEventService, EventService, InstantiationType.Delayed);

/**
 * `IEventService` — in-process pub-sub bus that fans out `Event`s coming out of
 * `KimiCore` (and synthetic events from daemon-side services) to all
 * in-process subscribers. Transport-agnostic: this interface does NOT know
 * about WS fan-out, ring buffers, sequence numbers, or replay — those are
 * daemon transport concerns, handled by `IWSBroadcastService` in
 * `@moonshot-ai/server`.
 *
 * The service sits on the receive-end of the in-process RPC adapter: when an
 * agent step emits an event, `CoreProcessService`'s `BridgeClientAPI.emitEvent`
 * forwards it to `IEventService.publish(event)`. Other in-process producers
 * (`PromptService` synthetic lifecycle events, `ApprovalService` /
 * `QuestionService` broker events) call `publish` directly.
 *
 * The impl (`EventService` in `./eventService.ts`) is a thin `Emitter<Event>`
 * wrapper — no per-session bookkeeping, no transport. The daemon-side
 * `WSBroadcastService` subscribes to `onDidPublish` to do the transport work.
 *
 * Decorator name `'eventService'` is the diagnostic string surfaced in
 * `CyclicDependencyError.path` and `'No service registered for identifier ...'`
 * messages.
 *
 * Role: pub-sub bus — see `packages/services/AGENTS.md`. Per-domain typed
 * `onDidXxx: Event<T>` accessors layer on top of this central stream
 * (e.g. `PromptService.onDidComplete`, `SessionService.onDidCreate`).
 */

import { createDecorator } from '../../di';
import type { Event } from '../../base/common/event';
import type { Event as ProtocolEvent } from '@moonshot-ai/protocol';

/**
 * Naming convention inside this file:
 *
 * - `Event` (from `@moonshot-ai/agent-core/base/common/event`) — the generic
 *   VSCode-style emitter accessor type. `Event<T>` is the listener-tuple
 *   type used to declare `readonly onDidXxx: Event<T>`.
 * - `ProtocolEvent` (alias of `@moonshot-ai/protocol`'s `Event`) — the
 *   wire-level event union published through the bus. Aliased here because
 *   the top-level `Event` symbol must refer to the emitter type so the
 *   accessor declarations read naturally (`Event<ProtocolEvent>` not
 *   `import('…/base/common/event').Event<Event>`).
 */
export interface IEventService {
  readonly _serviceBrand: undefined;

  /**
   * VSCode-style accessor — subscribe with a listener; returns an
   * `IDisposable` whose `dispose()` detaches. Handlers fire synchronously
   * inside `publish(event)`.
   *
   * Callers stash the returned `IDisposable` via
   * `Disposable._register(svc.onDidPublish(handler))` so the subscription
   * tears down with the owner.
   */
  readonly onDidPublish: Event<ProtocolEvent>;

  /**
   * Publish a fully-formed `Event` to all subscribers. Synchronous; the
   * adapter does not await delivery.
   */
  publish(event: ProtocolEvent): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IEventService = createDecorator<IEventService>('eventService');

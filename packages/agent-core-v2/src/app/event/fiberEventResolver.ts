/**
 * `event` domain — the production `FiberEventResolver` backing the string
 * form of the unit `on(...)` capability (`this.on('turn.ended', …)`).
 *
 * Resolves string event names against the unit scope's `IEventBus`: the
 * subscription attaches as soon as the bus is materialized in the scope (or
 * an ancestor), waits through a `liveRef` when it is not there yet, and
 * detaches with the unit's book. Scopes without an `IEventBus` (App) simply
 * never attach — per-agent domain events only exist under an Agent scope.
 * Imported for the registration side effect.
 */

import { setFiberEventResolver } from '#/_base/di/fiber';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';

import { type DomainEvent, type DomainEventMap, IEventBus } from './eventBus';

setFiberEventResolver((host, event, handler) => {
  const busRef = host.liveRef(IEventBus);
  let subscription: IDisposable | undefined;
  const attach = (): void => {
    if (subscription !== undefined) return;
    const bus = busRef.current;
    if (bus === undefined) return;
    subscription = bus.subscribe(
      event as keyof DomainEventMap,
      handler as (e: DomainEvent) => void,
    );
  };
  attach();
  const onChange = busRef.onDidChange(attach);
  return toDisposable(() => {
    onChange.dispose();
    subscription?.dispose();
  });
});

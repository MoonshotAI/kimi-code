// apps/kimi-web/src/composables/client/eventBatcher.ts
// Coalesce high-frequency streaming events onto the next animation frame.
//
// Pure logic (no Vue, no DOM) so it is unit-testable in isolation. See
// useKimiWebClient.ts for where it is wired into the WS event pipeline.

import type { AppEvent } from '../../api/types';

// Events that merely append a chunk to something already streaming. They can
// arrive dozens to hundreds of times per second, so they are worth coalescing.
const RENDER_EVENT_TYPES: ReadonlySet<AppEvent['type']> = new Set<AppEvent['type']>([
  'assistantDelta',
  'agentDelta',
  'toolOutput',
  'taskProgress',
]);

/** True for high-frequency render-only events that are safe to delay to the
    next animation frame. Everything else (lifecycle / control-flow) must apply
    immediately so turn-end cleanup etc. is not delayed by a throttled rAF. */
export function isRenderEvent(appEvent: AppEvent): boolean {
  return RENDER_EVENT_TYPES.has(appEvent.type);
}

function defaultScheduleFrame(cb: () => void): number {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number);
}

/**
 * Coalesce batchable items onto a single scheduled callback, while applying
 * non-batchable items immediately.
 *
 * A non-batchable item first drains any pending batchable items (in arrival
 * order) so overall ordering is preserved — a lifecycle event never overtakes
 * the deltas that arrived before it.
 *
 * The returned handle is itself callable (enqueue) and also exposes `flush()`
 * to synchronously drain pending batchable items. Callers that replace state
 * authoritatively (e.g. applying a server snapshot) must `flush()` first so
 * stale queued deltas are not applied on top of the new state.
 */
export interface EventBatcher<T> {
  (item: T): void;
  /** Synchronously drain any pending batchable items in arrival order. */
  flush(): void;
}

export function createEventBatcher<T>(
  process: (item: T) => void,
  isBatchable: (item: T) => boolean,
  schedule: (cb: () => void) => number = defaultScheduleFrame,
): EventBatcher<T> {
  let pending: T[] = [];
  let handle: number | null = null;

  const drain = (): void => {
    handle = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    for (const item of batch) process(item);
  };

  const enqueue = ((item: T) => {
    if (isBatchable(item)) {
      pending.push(item);
      if (handle === null) handle = schedule(drain);
      return;
    }
    // Immediate item: flush pending batchables first to preserve order.
    drain();
    process(item);
  }) as EventBatcher<T>;

  enqueue.flush = drain;

  return enqueue;
}

// apps/kimi-web/src/composables/client/eventBatcher.ts
// Coalesce high-frequency streaming events and apply them in bounded slices.
//
// Pure logic (no Vue) so the queue, ordering, and scheduler fallback can be
// tested directly. See useKimiWebClient.ts for the WS pipeline wiring.

import type { AppEvent, KimiEventMeta } from '../../api/types';

// Events that merely append a chunk to something already streaming. They can
// arrive dozens to hundreds of times per second, so they are worth batching.
const RENDER_EVENT_TYPES: ReadonlySet<AppEvent['type']> = new Set<AppEvent['type']>([
  'assistantDelta',
  'agentDelta',
  'toolOutput',
  'taskProgress',
]);

/** True for high-frequency render events. Lifecycle / control events remain
    ordering barriers and are never merged with render events. */
export function isRenderEvent(appEvent: AppEvent): boolean {
  return RENDER_EVENT_TYPES.has(appEvent.type);
}

export interface EventBatcherScheduler {
  /** Request the next visual frame. Return null when frames are unavailable. */
  requestFrame(callback: () => void): number | null;
  cancelFrame(handle: number): void;
  /** Request a task that still runs when animation frames are suspended. */
  requestTask(callback: () => void): number;
  cancelTask(handle: number): void;
}

const FALLBACK_TASK_DELAY_MS = 50;
const DEFAULT_MAX_ITEMS_PER_SLICE = 100;
/** Keep each append passed to the reducer small enough that concatenation and
 *  Markdown invalidation remain bounded. Offsets use JS string lengths, so the
 *  limit is measured in UTF-16 code units too. */
const MAX_COALESCED_STREAM_CHARS = 32 * 1024;

const defaultScheduler: EventBatcherScheduler = {
  requestFrame(callback) {
    return typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(callback)
      : null;
  },
  cancelFrame(handle) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  },
  requestTask(callback) {
    return setTimeout(callback, FALLBACK_TASK_DELAY_MS) as unknown as number;
  },
  cancelTask(handle) {
    clearTimeout(handle);
  },
};

export interface EventBatcherOptions<T> {
  /** Merge the new item into the last pending item, or return undefined. */
  coalesce?: (previous: T, next: T) => T | undefined;
  /** Maximum queued groups processed by one scheduled or synchronous slice. */
  maxItemsPerSlice?: number;
  scheduler?: EventBatcherScheduler;
}

/**
 * Queue batchable items until the next frame (or task fallback), while keeping
 * control events in arrival order. A control event triggers one bounded slice:
 * short/coalesced queues still settle immediately, while a large queue resumes
 * on later frames instead of becoming one long main-thread task.
 */
export interface EventBatcher<T> {
  (item: T): void;
  /** Synchronously drain every pending item. Reserved for authoritative state replacement. */
  flush(): void;
  /** Drop queued items that no longer have a valid owner. */
  discard(predicate: (item: T) => boolean): void;
  /** Cancel scheduled work and permanently discard this batcher's queue. */
  dispose(): void;
}

export function createEventBatcher<T>(
  process: (item: T) => void,
  isBatchable: (item: T) => boolean,
  options: EventBatcherOptions<T> = {},
): EventBatcher<T> {
  const scheduler = options.scheduler ?? defaultScheduler;
  const maxItemsPerSlice = Math.max(
    1,
    Math.floor(options.maxItemsPerSlice ?? DEFAULT_MAX_ITEMS_PER_SLICE),
  );
  const pending: T[] = [];
  let head = 0;
  let frameHandle: number | null = null;
  let taskHandle: number | null = null;
  let scheduleVersion = 0;
  let disposed = false;

  const countPending = (): number => pending.length - head;

  const cancelScheduled = (): void => {
    scheduleVersion += 1;
    if (frameHandle !== null) {
      scheduler.cancelFrame(frameHandle);
      frameHandle = null;
    }
    if (taskHandle !== null) {
      scheduler.cancelTask(taskHandle);
      taskHandle = null;
    }
  };

  const compactQueue = (): void => {
    if (head === pending.length) {
      pending.length = 0;
      head = 0;
    } else if (head >= 1024) {
      pending.splice(0, head);
      head = 0;
    }
  };

  let drainSlice: () => void;

  const scheduleDrain = (): void => {
    if (
      disposed ||
      frameHandle !== null ||
      taskHandle !== null ||
      countPending() === 0
    ) {
      return;
    }
    const version = ++scheduleVersion;
    const run = (): void => {
      if (version !== scheduleVersion) return;
      drainSlice();
    };
    frameHandle = scheduler.requestFrame(run);
    taskHandle = scheduler.requestTask(run);
  };

  drainSlice = (): void => {
    cancelScheduled();
    let processed = 0;
    while (!disposed && processed < maxItemsPerSlice && head < pending.length) {
      const item = pending[head++]!;
      process(item);
      processed += 1;
    }
    compactQueue();
    scheduleDrain();
  };

  const enqueue = ((item: T) => {
    if (disposed) return;
    if (isBatchable(item)) {
      const previous = pending.length > head ? pending.at(-1) : undefined;
      const merged = previous === undefined ? undefined : options.coalesce?.(previous, item);
      if (merged === undefined) pending.push(item);
      else pending[pending.length - 1] = merged;
      scheduleDrain();
      return;
    }

    if (countPending() === 0) {
      process(item);
      return;
    }

    // Keep the control event behind everything that arrived before it. Process
    // one bounded slice now so a short/coalesced stream still completes without
    // waiting for another frame; schedule the remainder when the budget is hit.
    pending.push(item);
    drainSlice();
  }) as EventBatcher<T>;

  enqueue.flush = (): void => {
    if (disposed) return;
    cancelScheduled();
    while (!disposed && head < pending.length) process(pending[head++]!);
    compactQueue();
  };
  enqueue.discard = (predicate): void => {
    if (disposed || countPending() === 0) return;
    let write = head;
    for (let read = head; read < pending.length; read += 1) {
      const item = pending[read]!;
      if (!predicate(item)) pending[write++] = item;
    }
    pending.length = write;
    compactQueue();
    if (countPending() === 0) cancelScheduled();
    else scheduleDrain();
  };
  enqueue.dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelScheduled();
    pending.length = 0;
    head = 0;
  };

  return enqueue;
}

export interface PendingAppEvent {
  appEvent: AppEvent;
  meta: KimiEventMeta;
}

interface AssistantChunk {
  kind: 'text' | 'thinking';
  value: string;
}

function assistantChunk(event: AppEvent): AssistantChunk | undefined {
  if (event.type !== 'assistantDelta') return undefined;
  if (event.delta.text !== undefined && event.delta.thinking === undefined) {
    return { kind: 'text', value: event.delta.text };
  }
  if (event.delta.thinking !== undefined && event.delta.text === undefined) {
    return { kind: 'thinking', value: event.delta.thinking };
  }
  return undefined;
}

/**
 * A single server frame can already contain a large coalesced delta. Split it
 * before enqueueing so the per-group cap also holds for that case. Every part
 * keeps the wire seq and advances only the raw stream offset.
 */
export function splitOversizedAppRenderEvent(
  item: PendingAppEvent,
): readonly PendingAppEvent[] {
  if (item.appEvent.type !== 'assistantDelta') return [item];
  const appEvent = item.appEvent;
  const stream = item.meta.stream;
  const chunk = assistantChunk(appEvent);
  if (
    stream === undefined ||
    chunk === undefined ||
    stream.kind !== chunk.kind ||
    chunk.value.length <= MAX_COALESCED_STREAM_CHARS
  ) {
    return [item];
  }

  const parts: PendingAppEvent[] = [];
  let start = 0;
  while (start < chunk.value.length) {
    let end = Math.min(start + MAX_COALESCED_STREAM_CHARS, chunk.value.length);
    // Do not expose an unpaired surrogate in an intermediate render. Moving
    // the boundary back by one still preserves offset continuity because raw
    // offsets are counted in UTF-16 code units.
    if (
      end < chunk.value.length &&
      end > start &&
      /[\uD800-\uDBFF]/u.test(chunk.value[end - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(chunk.value[end]!)
    ) {
      end -= 1;
    }
    const value = chunk.value.slice(start, end);
    parts.push({
      appEvent: {
        ...appEvent,
        delta: chunk.kind === 'text' ? { text: value } : { thinking: value },
      },
      meta: {
        ...item.meta,
        stream: { ...stream, offset: stream.offset + start },
      },
    });
    start = end;
  }
  return parts;
}

/**
 * Merge adjacent main-assistant text/thinking deltas only when their complete
 * stream identity and offsets prove that concatenation is lossless.
 *
 * Protocol/stub events without raw stream metadata deliberately stay separate.
 * Control events and other render-event types are never merged.
 */
export function coalesceAppRenderEvents(
  previous: PendingAppEvent,
  next: PendingAppEvent,
): PendingAppEvent | undefined {
  if (previous.appEvent.type !== 'assistantDelta' || next.appEvent.type !== 'assistantDelta') {
    return undefined;
  }
  const previousStream = previous.meta.stream;
  const nextStream = next.meta.stream;
  const previousChunk = assistantChunk(previous.appEvent);
  const nextChunk = assistantChunk(next.appEvent);
  if (
    previousStream === undefined ||
    nextStream === undefined ||
    previousChunk === undefined ||
    nextChunk === undefined ||
    previous.meta.sessionId !== next.meta.sessionId ||
    previous.appEvent.sessionId !== next.appEvent.sessionId ||
    previous.appEvent.messageId !== next.appEvent.messageId ||
    previous.appEvent.contentIndex !== next.appEvent.contentIndex ||
    previousStream.turnId !== nextStream.turnId ||
    previousStream.kind !== nextStream.kind ||
    previousChunk.kind !== nextChunk.kind ||
    previousStream.kind !== previousChunk.kind ||
    nextStream.kind !== nextChunk.kind ||
    nextStream.offset !== previousStream.offset + previousChunk.value.length ||
    previousChunk.value.length + nextChunk.value.length > MAX_COALESCED_STREAM_CHARS
  ) {
    return undefined;
  }

  const value = previousChunk.value + nextChunk.value;
  return {
    appEvent: {
      ...previous.appEvent,
      delta: previousChunk.kind === 'text' ? { text: value } : { thinking: value },
    },
    // Advance the durable watermark with the newest frame while preserving the
    // first offset of the merged chunk for the next continuity check.
    meta: {
      ...next.meta,
      stream: { ...previousStream },
    },
  };
}

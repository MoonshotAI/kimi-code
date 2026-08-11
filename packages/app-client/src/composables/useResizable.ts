// packages/app-client/src/composables/useResizable.ts
// A small reusable hook for a horizontal drag-to-resize handle. It owns the
// width value, clamps it to [min, max], persists it to localStorage, and wires
// up pointer events (pointerdown/move/up with capture, no text-selection while
// dragging). Used by the sidebar session column drag handle.
//
// Drag performance: pointermove can fire well above display rate, so width
// updates are coalesced into one per animation frame, and localStorage is
// written once when the drag ends — not per move event.
//
// The resize cursor is directional: at the eastward/westward limit it shows
// w-resize/e-resize (the direction that still has an effect) instead of the
// neutral col-resize.

import { computed, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue';
import { safeGetString, safeSetString } from '@moonshot-ai/app-core/lib';

export interface UseResizableOptions {
  /** localStorage key the chosen width is persisted under. */
  storageKey: string;
  /** Width to fall back to when nothing is stored / value is invalid. */
  defaultWidth: number;
  /** Smallest allowed width (px). */
  min: number;
  /** Largest allowed width (px). Accepts a ref/getter so a cap derived from the
   *  viewport keeps working as the window is resized after the handle mounts. */
  max: MaybeRefOrGetter<number>;
  /** True when dragging right should shrink the controlled width. */
  reverse?: boolean;
  /** Drag axis: 'x' (default) resizes a width, 'y' a height (clientY deltas,
   *  row/n/s-resize cursors). The option/return names stay *width* either way. */
  axis?: 'x' | 'y';
  /** Optional live applier for drag frames. When set, each animation frame
   *  calls it with the latest clamped width INSTEAD of updating the `width`
   *  ref — the caller writes straight to the DOM, keeping Vue re-renders out
   *  of the per-frame loop. The ref (and localStorage) commit once on drag
   *  end, so `update:width` watchers only fire then. */
  applyLive?: (width: number) => void;
}

export interface UseResizable {
  /** Current width in px (already clamped). */
  width: Ref<number>;
  /** True while a drag is in progress. */
  dragging: Ref<boolean>;
  /** Cursor reflecting the directions that still resize: col-resize mid-range,
   *  w-resize/e-resize at the eastward/westward limit. */
  cursor: Ref<string>;
  /** Clamp a value to [min, max]. */
  clamp: (value: number) => number;
  /** Set the width (clamped + persisted). */
  setWidth: (value: number) => void;
  /** pointerdown handler to attach to the drag handle. */
  onPointerDown: (event: PointerEvent) => void;
}

function readStored(key: string): number | null {
  try {
    const raw = safeGetString(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: number): void {
  try {
    safeSetString(key, String(value));
  } catch {
    // localStorage unavailable (e.g. private mode) — width still works in-memory
  }
}

export function useResizable(options: UseResizableOptions): UseResizable {
  const { storageKey, defaultWidth, min, max, reverse = false, axis = 'x', applyLive } = options;

  function clamp(value: number): number {
    if (!Number.isFinite(value)) return defaultWidth;
    return Math.min(toValue(max), Math.max(min, Math.round(value)));
  }

  const width = ref<number>(clamp(readStored(storageKey) ?? defaultWidth));
  const dragging = ref(false);

  // The cursor names the direction that still has an effect: at the eastward
  // limit only westward dragging resizes (w-resize), and vice versa. `reverse`
  // flips which direction grows the width. On the y axis the pairs are
  // n/s-resize with a row-resize neutral.
  function cursorFor(w: number): string {
    const atMin = w <= min;
    const atMax = w >= toValue(max);
    const neutral = axis === 'x' ? 'col-resize' : 'row-resize';
    if (atMin && atMax) return neutral; // no room to move at all
    const [growCursor, shrinkCursor] = axis === 'x' ? ['e-resize', 'w-resize'] : ['s-resize', 'n-resize'];
    if (atMax) return reverse ? growCursor : shrinkCursor;
    if (atMin) return reverse ? shrinkCursor : growCursor;
    return neutral;
  }

  // Live drag width, non-null only while dragging. Drives the cursor (and the
  // handle bound to it) even on the applyLive path, where `width` stays put
  // until drag end — an element's own cursor style always beats what it would
  // inherit from <body>, so the handle's binding must track the drag itself.
  const dragWidth = ref<number | null>(null);
  const cursor = computed(() => cursorFor(dragWidth.value ?? width.value));

  // Drag cursor on the body: elements without their own cursor style inherit
  // it, so the resize cursor still follows the pointer off the handle.
  function setDragCursor(w: number): void {
    if (typeof document === 'undefined') return;
    document.body.style.cursor = cursorFor(w);
  }

  function setWidth(value: number): void {
    const next = clamp(value);
    width.value = next;
    writeStored(storageKey, next);
  }

  // A shrinking cap (window resize) pulls the committed width down with it —
  // otherwise the stale over-cap value resurfaces on the next drag/keyboard
  // step and jumps the panel back above the clamp.
  watch(
    () => toValue(max),
    (cap) => {
      if (!dragging.value && width.value > cap) setWidth(cap);
    },
  );

  // Drag bookkeeping — captured at pointerdown so we resize relative to the
  // start point rather than absolute cursor coordinates. "Position" is clientX
  // on the x axis, clientY on the y axis.
  let startX = 0;
  let startWidth = 0;
  let activeEl: HTMLElement | null = null;
  let activePointerId = -1;
  // Latest pointer position and the frame its update is scheduled on.
  let latestClientX = 0;
  let rafId = 0;
  // Last clamped drag width; the applyLive path commits it to the ref on
  // drag end, so it is tracked even while the ref stays untouched.
  let latestDragWidth = 0;

  // Applies the latest drag position. Deliberately skips localStorage — that
  // is written once in endDrag, not per frame. With applyLive set, the width
  // goes straight to the DOM and the ref keeps its pre-drag value.
  function applyDragWidth(): void {
    rafId = 0;
    if (!dragging.value) return;
    const delta = latestClientX - startX;
    latestDragWidth = clamp(startWidth + (reverse ? -delta : delta));
    dragWidth.value = latestDragWidth; // keep the handle's cursor live
    // Track the limit mid-drag: hitting it flips the cursor to the one
    // direction that still resizes.
    setDragCursor(latestDragWidth);
    if (applyLive) applyLive(latestDragWidth);
    else width.value = latestDragWidth;
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging.value) return;
    latestClientX = axis === 'x' ? event.clientX : event.clientY;
    if (rafId !== 0) return; // a frame with the newest position is already pending
    if (typeof requestAnimationFrame !== 'function') {
      applyDragWidth(); // no rAF (non-DOM environment) — update synchronously
      return;
    }
    rafId = requestAnimationFrame(applyDragWidth);
  }

  function endDrag(): void {
    if (!dragging.value) return;
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      // Commit the position the pointer was released at, not the last frame's.
      applyDragWidth();
    }
    dragging.value = false;
    if (applyLive) {
      // The live path kept the ref (and Vue) out of the per-frame loop —
      // commit the final width once, now that the drag is over.
      setWidth(latestDragWidth);
    } else {
      writeStored(storageKey, width.value);
    }
    dragWidth.value = null; // cursor falls back to the committed width
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    if (activeEl) {
      try {
        activeEl.releasePointerCapture(activePointerId);
      } catch {
        // pointer capture may already be released
      }
      activeEl.removeEventListener('pointermove', onPointerMove);
      activeEl.removeEventListener('pointerup', endDrag);
      activeEl.removeEventListener('pointercancel', endDrag);
    }
    activeEl = null;
    activePointerId = -1;
  }

  function onPointerDown(event: PointerEvent): void {
    event.preventDefault();
    dragging.value = true;
    startX = axis === 'x' ? event.clientX : event.clientY;
    // The stored width can exceed the current cap (e.g. after the window narrows
    // or a side panel opens). Clamp the drag start so the handle responds
    // immediately instead of first covering an invisible delta.
    startWidth = clamp(width.value);
    latestDragWidth = startWidth;
    activeEl = event.currentTarget as HTMLElement;
    activePointerId = event.pointerId;
    // Suppress text selection / show a resize cursor for the whole drag.
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = 'none';
    }
    setDragCursor(startWidth);
    try {
      activeEl.setPointerCapture(activePointerId);
    } catch {
      // setPointerCapture may be unavailable in some test environments
    }
    activeEl.addEventListener('pointermove', onPointerMove);
    activeEl.addEventListener('pointerup', endDrag);
    activeEl.addEventListener('pointercancel', endDrag);
  }

  onBeforeUnmount(endDrag);

  return { width, dragging, cursor, clamp, setWidth, onPointerDown };
}

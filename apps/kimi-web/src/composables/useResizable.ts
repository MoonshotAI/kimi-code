// apps/kimi-web/src/composables/useResizable.ts
// A small reusable hook for a horizontal drag-to-resize handle. It owns the
// width value, clamps it to [min, max], persists it to localStorage, and wires
// up pointer events (pointerdown/move/up with capture, no text-selection while
// dragging). Used by the sidebar session column drag handle.

import { onBeforeUnmount, ref, toValue, type MaybeRefOrGetter, type Ref } from 'vue';
import { safeGetString, safeSetString } from '../lib/storage';

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
}

export interface UseResizable {
  /** Current width in px (already clamped). */
  width: Ref<number>;
  /** True while a drag is in progress. */
  dragging: Ref<boolean>;
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
  const { storageKey, defaultWidth, min, max, reverse = false } = options;

  function clamp(value: number): number {
    if (!Number.isFinite(value)) return defaultWidth;
    return Math.min(toValue(max), Math.max(min, Math.round(value)));
  }

  const width = ref<number>(clamp(readStored(storageKey) ?? defaultWidth));
  const dragging = ref(false);

  function setWidth(value: number): void {
    const next = clamp(value);
    width.value = next;
    writeStored(storageKey, next);
  }

  // Drag bookkeeping — captured at pointerdown so we resize relative to the
  // start point rather than absolute cursor coordinates.
  let startX = 0;
  let startWidth = 0;
  let activeEl: HTMLElement | null = null;
  let activePointerId = -1;

  function onPointerMove(event: PointerEvent): void {
    if (!dragging.value) return;
    const delta = event.clientX - startX;
    setWidth(startWidth + (reverse ? -delta : delta));
  }

  function endDrag(): void {
    if (!dragging.value) return;
    dragging.value = false;
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
    startX = event.clientX;
    // The stored width can exceed the current cap (e.g. after the window narrows
    // or a side panel opens). Clamp the drag start so the handle responds
    // immediately instead of first covering an invisible delta.
    startWidth = clamp(width.value);
    activeEl = event.currentTarget as HTMLElement;
    activePointerId = event.pointerId;
    // Suppress text selection / show a resize cursor for the whole drag.
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    }
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

  return { width, dragging, clamp, setWidth, onPointerDown };
}

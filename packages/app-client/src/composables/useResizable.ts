
import { computed, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue';
import { safeGetString, safeSetString } from '@moonshot-ai/app-core/lib';

export interface UseResizableOptions {
  storageKey: string;
  defaultWidth: number;
  min: MaybeRefOrGetter<number>;
  max: MaybeRefOrGetter<number>;
  reverse?: MaybeRefOrGetter<boolean>;
  axis?: 'x' | 'y';
  applyLive?: (width: number) => void;
  persist?: () => boolean;
}

export interface UseResizable {
  width: Ref<number>;
  dragging: Ref<boolean>;
  cursor: Ref<string>;
  clamp: (value: number) => number;
  setWidth: (value: number) => void;
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
  } catch {}
}

export function useResizable(options: UseResizableOptions): UseResizable {
  const { storageKey, defaultWidth, min, max, reverse = false, axis = 'x', applyLive, persist } = options;

  function clamp(value: number): number {
    if (!Number.isFinite(value)) return defaultWidth;
    return Math.min(toValue(max), Math.max(toValue(min), Math.round(value)));
  }

  let committed = readStored(storageKey) ?? defaultWidth;
  const width = ref<number>(clamp(committed));
  const dragging = ref(false);

  function cursorFor(w: number): string {
    const atMin = w <= toValue(min);
    const atMax = w >= toValue(max);
    const neutral = axis === 'x' ? 'col-resize' : 'row-resize';
    if (atMin && atMax) return neutral;
    const [growCursor, shrinkCursor] = axis === 'x' ? ['e-resize', 'w-resize'] : ['s-resize', 'n-resize'];
    if (atMax) return toValue(reverse) ? growCursor : shrinkCursor;
    if (atMin) return toValue(reverse) ? shrinkCursor : growCursor;
    return neutral;
  }

  const dragWidth = ref<number | null>(null);
  const cursor = computed(() => cursorFor(dragWidth.value ?? width.value));

  let shield: HTMLElement | null = null;

  function setDragCursor(w: number): void {
    const next = cursorFor(w);
    if (shield && shield.style.cursor !== next) shield.style.cursor = next;
  }

  function raiseShield(w: number): void {
    if (typeof document === 'undefined') return;
    shield = document.createElement('div');
    shield.className = 'resize-drag-shield';
    shield.style.cursor = cursorFor(w);
    shield.addEventListener('pointerdown', endDrag);
    shield.addEventListener('pointerup', endDrag);
    shield.addEventListener('pointermove', endDrag);
    document.body.append(shield);
    if (typeof window !== 'undefined') window.addEventListener('blur', endDrag);
  }

  function lowerShield(): void {
    shield?.remove();
    shield = null;
    if (typeof window !== 'undefined') window.removeEventListener('blur', endDrag);
  }

  function write(value: number): void {
    if (persist && !persist()) return;
    writeStored(storageKey, value);
  }

  function setWidth(value: number): void {
    const next = clamp(value);
    committed = next;
    width.value = next;
    write(next);
  }

  watch([() => toValue(min), () => toValue(max)], () => {
    if (!dragging.value) width.value = clamp(committed);
  });

  let startX = 0;
  let startWidth = 0;
  let activeEl: HTMLElement | null = null;
  let activePointerId = -1;
  let latestClientX = 0;
  let rafId = 0;
  let latestDragWidth = 0;

  function applyDragWidth(): void {
    rafId = 0;
    if (!dragging.value) return;
    const delta = latestClientX - startX;
    latestDragWidth = clamp(startWidth + (toValue(reverse) ? -delta : delta));
    dragWidth.value = latestDragWidth;
    setDragCursor(latestDragWidth);
    if (applyLive) applyLive(latestDragWidth);
    else width.value = latestDragWidth;
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging.value) return;
    if (event.buttons === 0) {
      endDrag();
      return;
    }
    latestClientX = axis === 'x' ? event.clientX : event.clientY;
    if (rafId !== 0) return;
    if (typeof requestAnimationFrame !== 'function') {
      applyDragWidth();
      return;
    }
    rafId = requestAnimationFrame(applyDragWidth);
  }

  function endDrag(): void {
    if (!dragging.value) return;
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      applyDragWidth();
    }
    dragging.value = false;
    if (latestDragWidth !== startWidth) {
      if (applyLive) {
        setWidth(latestDragWidth);
      } else {
        committed = width.value;
        write(width.value);
      }
    } else {
      width.value = clamp(width.value);
    }
    dragWidth.value = null;
    lowerShield();
    if (activeEl) {
      try {
        activeEl.releasePointerCapture(activePointerId);
      } catch {}
      activeEl.removeEventListener('pointermove', onPointerMove);
      activeEl.removeEventListener('pointerup', endDrag);
      activeEl.removeEventListener('pointercancel', endDrag);
      activeEl.removeEventListener('lostpointercapture', endDrag);
    }
    activeEl = null;
    activePointerId = -1;
  }

  function onPointerDown(event: PointerEvent): void {
    event.preventDefault();
    dragging.value = true;
    startX = axis === 'x' ? event.clientX : event.clientY;
    startWidth = clamp(width.value);
    latestDragWidth = startWidth;
    activeEl = event.currentTarget as HTMLElement;
    activePointerId = event.pointerId;
    raiseShield(startWidth);
    try {
      activeEl.setPointerCapture(activePointerId);
    } catch {}
    activeEl.addEventListener('pointermove', onPointerMove);
    activeEl.addEventListener('pointerup', endDrag);
    activeEl.addEventListener('pointercancel', endDrag);
    activeEl.addEventListener('lostpointercapture', endDrag);
  }

  onBeforeUnmount(endDrag);

  return { width, dragging, cursor, clamp, setWidth, onPointerDown };
}

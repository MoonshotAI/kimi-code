
import { computed, onBeforeUnmount, ref, type Ref } from 'vue';

export interface OverlayScrollbarThumb {
  top: number;
  height: number;
}

export function overlayScrollbarThumb(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  trackInset: number,
  thumbMin: number,
): OverlayScrollbarThumb | null {
  if (scrollHeight <= clientHeight + 1) return null;
  const track = clientHeight - trackInset * 2;
  if (track <= 0) return null;
  const height = Math.min(track, Math.max(thumbMin, (clientHeight / scrollHeight) * track));
  const maxScroll = scrollHeight - clientHeight;
  const top = trackInset + (scrollTop / maxScroll) * (track - height);
  return { top, height };
}

export interface UseOverlayScrollbar {
  thumb: Ref<OverlayScrollbarThumb | null>;
  thumbVisible: Ref<boolean>;
  scrolling: Ref<boolean>;
  update: () => void;
  markScrolling: () => void;
  onThumbPointerDown: (event: PointerEvent) => void;
  onListMouseEnter: () => void;
  onListMouseLeave: () => void;
  onThumbMouseEnter: () => void;
  onThumbMouseLeave: () => void;
}

const SCROLL_IDLE_HIDE_MS = 900;

function readCssNumber(el: HTMLElement, name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

export function dragOverlayScrollbarThumb(
  event: PointerEvent,
  el: HTMLElement,
  thumbHeight: number,
  trackInset: number,
  onStop: () => void,
): () => void {
  event.preventDefault();
  const dragPointerId = event.pointerId;
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  const trackRange = el.clientHeight - trackInset * 2 - thumbHeight;
  const scrollRange = el.scrollHeight - el.clientHeight;
  const startY = event.clientY;
  const startScrollTop = el.scrollTop;
  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== dragPointerId || trackRange <= 0) return;
    el.scrollTop = startScrollTop + ((ev.clientY - startY) / trackRange) * scrollRange;
  };
  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== dragPointerId) return;
    stop();
  };
  const stop = (): void => {
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointercancel', onUp);
    onStop();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  return stop;
}

export function useOverlayScrollbar(scrollEl: Ref<HTMLElement | null>): UseOverlayScrollbar {
  const thumb = ref<OverlayScrollbarThumb | null>(null);
  const listHover = ref(false);
  const thumbHover = ref(false);
  const scrolling = ref(false);
  const dragging = ref(false);

  const thumbVisible = computed(
    () =>
      thumb.value !== null &&
      (listHover.value || thumbHover.value || scrolling.value || dragging.value),
  );

  function update(): void {
    const el = scrollEl.value;
    if (!el) {
      thumb.value = null;
      return;
    }
    const geometry = overlayScrollbarThumb(
      el.scrollTop,
      el.scrollHeight,
      el.clientHeight,
      readCssNumber(el, '--overlay-scrollbar-track-inset', 0),
      readCssNumber(el, '--overlay-scrollbar-thumb-min', 24),
    );
    const next =
      geometry === null ? null : { top: el.offsetTop + geometry.top, height: geometry.height };
    const prev = thumb.value;
    if (prev !== null && next !== null && prev.top === next.top && prev.height === next.height) {
      return;
    }
    thumb.value = next;
  }

  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function markScrolling(): void {
    scrolling.value = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      scrolling.value = false;
      hideTimer = null;
    }, SCROLL_IDLE_HIDE_MS);
  }

  let activeDragCleanup: (() => void) | null = null;

  function onThumbPointerDown(event: PointerEvent): void {
    const el = scrollEl.value;
    const current = thumb.value;
    if (!el || !current) return;
    activeDragCleanup?.();
    dragging.value = true;
    const stop = dragOverlayScrollbarThumb(event, el, current.height, readCssNumber(el, '--overlay-scrollbar-track-inset', 0), () => {
      dragging.value = false;
      if (activeDragCleanup === stop) activeDragCleanup = null;
    });
    activeDragCleanup = stop;
  }

  function onListMouseEnter(): void {
    listHover.value = true;
  }
  function onListMouseLeave(): void {
    listHover.value = false;
  }
  function onThumbMouseEnter(): void {
    thumbHover.value = true;
  }
  function onThumbMouseLeave(): void {
    thumbHover.value = false;
  }

  onBeforeUnmount(() => {
    if (hideTimer) clearTimeout(hideTimer);
    activeDragCleanup?.();
  });

  return {
    thumb,
    thumbVisible,
    scrolling,
    update,
    markScrolling,
    onThumbPointerDown,
    onListMouseEnter,
    onListMouseLeave,
    onThumbMouseEnter,
    onThumbMouseLeave,
  };
}

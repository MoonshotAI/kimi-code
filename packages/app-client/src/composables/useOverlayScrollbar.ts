// packages/app-client/src/composables/useOverlayScrollbar.ts
// Overlay scrollbar for list scrollers (the sidebar's session list, the
// pinned rows): the native bar is hidden entirely (scrollbar-width: none +
// ::-webkit-scrollbar display:none in the component's styles), so a layout
// scrollbar can never eat row width and the rows' left/right insets stay
// symmetric whether or not the list scrolls. In its place a floating thumb
// element mirrors the scroll position — hidden at rest, revealed while the
// pointer hovers the list or while scrolling, fading back out once idle.
//
// The component owns the scroller and the thumb element; this hook owns the
// thumb geometry (recomputed on scroll/resize/content changes via `update`),
// the visibility state (hover / scrolling / dragging), and the thumb's drag
// interaction (the thumb is the only scroll affordance, so it must drag —
// same contract as the composer menus' overlay thumbs).
//
// Geometry contract: the thumb element's offsetParent must be the scroller's
// offsetParent too (e.g. both absolute/flex children of one positioned
// wrapper), because `top` is expressed in that shared coordinate space via
// the scroller's offsetTop. Track inset and the minimum thumb height are
// read from the scroller's computed style so the values stay on the design
// tokens: --overlay-scrollbar-track-inset (default 0) and
// --overlay-scrollbar-thumb-min (default 24px, the menus' recipe).

import { computed, onBeforeUnmount, ref, type Ref } from 'vue';

export interface OverlayScrollbarThumb {
  top: number;
  height: number;
}

// Pure thumb geometry, exported for tests: null while the content fits (no
// scrollable overflow — the 1px slack matches the scroll-state edge checks),
// else the thumb's offset/height inside the track. The track is the visible
// height shrunk by the inset on both ends; the thumb height follows the
// visible fraction, floored at thumbMin so it stays grabbable, and capped at
// the track itself so a degenerate (tiny) scroller can't invert the range.
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
  /** Thumb geometry in the shared offsetParent space (null = not scrollable). */
  thumb: Ref<OverlayScrollbarThumb | null>;
  /** Reveal the thumb: hovering the list or the thumb, scrolling, dragging. */
  thumbVisible: Ref<boolean>;
  /** True from each scroll event until the idle fade delay elapses — exposed
   *  so a component can keep its long-standing `scrolling` class contract. */
  scrolling: Ref<boolean>;
  /** Re-read the scroller and recompute the thumb (scroll handlers, resize /
   *  mutation observers, post-render hooks). */
  update: () => void;
  /** Mark the list as actively scrolling (keeps the thumb up briefly after
   *  the last scroll event — the idle fade). Call from the scroll handler. */
  markScrolling: () => void;
  /** pointerdown handler for the thumb element (drag-to-scroll). */
  onThumbPointerDown: (event: PointerEvent) => void;
  onListMouseEnter: () => void;
  onListMouseLeave: () => void;
  onThumbMouseEnter: () => void;
  onThumbMouseLeave: () => void;
}

// How long the thumb lingers after the last scroll event (the sidebar's
// long-standing idle-fade delay).
const SCROLL_IDLE_HIDE_MS = 900;

function readCssNumber(el: HTMLElement, name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
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
    // offsetTop anchors the scroller-local track to the shared offsetParent
    // space the thumb is positioned in (see the header contract).
    const next =
      geometry === null ? null : { top: el.offsetTop + geometry.top, height: geometry.height };
    // Components re-run their scroll-state refresh after EVERY render
    // (onUpdated), so the thumb ref is replaced only on a real change: a
    // fresh identity each pass re-triggers the template's thumb bindings
    // (v-if / :style / :class) → re-render → onUpdated → refresh, an
    // unbounded update loop that starves every other interaction (this is
    // what broke the pinned rows' resize drag — the same guard
    // PinnedSessionList's firstRowHeights block documents).
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

  // Drag-to-scroll: pointer capture + proportional scrollTop (the composer
  // menus' recipe). The scroller may sit under a folded pane or inside a
  // transitioning panel, so the geometry is read live at the gesture start.
  function onThumbPointerDown(event: PointerEvent): void {
    const el = scrollEl.value;
    const current = thumb.value;
    if (!el || !current) return;
    event.preventDefault();
    // A drag belongs to the pointer that started it: a second touch must not
    // move the thumb or end the session. End any stale session first.
    activeDragCleanup?.();
    const dragPointerId = event.pointerId;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    const inset = readCssNumber(el, '--overlay-scrollbar-track-inset', 0);
    const trackRange = el.clientHeight - inset * 2 - current.height;
    const scrollRange = el.scrollHeight - el.clientHeight;
    const startY = event.clientY;
    const startScrollTop = el.scrollTop;
    dragging.value = true;
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== dragPointerId || trackRange <= 0) return;
      el.scrollTop = startScrollTop + ((ev.clientY - startY) / trackRange) * scrollRange;
    };
    // No `once: true` — a foreign pointer's up/cancel must be ignored without
    // deregistering the listener before the drag pointer's own arrives.
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== dragPointerId) return;
      stop();
    };
    const stop = (): void => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointercancel', onUp);
      dragging.value = false;
      if (activeDragCleanup === stop) activeDragCleanup = null;
    };
    activeDragCleanup = stop;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // A touch gesture can be cancelled without a pointerup — same cleanup.
    window.addEventListener('pointercancel', onUp);
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

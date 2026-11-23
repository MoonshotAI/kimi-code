import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref, type WatchSource } from 'vue';
import { dragOverlayScrollbarThumb, overlayScrollbarThumb, type OverlayScrollbarThumb } from '@moonshot-ai/app-client/composables';
import { ensurePointerTracking, isSyntheticPointerMove } from '@moonshot-ai/app-ui';

function cssNumber(el: HTMLElement, name: string, fallback: number): number {
  return parseFloat(getComputedStyle(el).getPropertyValue(name)) || fallback;
}

export interface ComposerMenuScrollOptions {
  layout: () => 'popup' | 'sheet';
  items: () => readonly unknown[];
  activeIndex: () => number;
  maxHeightVar: string;
  headEl?: Ref<HTMLElement | null>;
  refitOn?: WatchSource;
  contentOn?: WatchSource;
  onHover: (index: number) => void;
}

export function useComposerMenuScroll(options: ComposerMenuScrollOptions) {
  const scrollEl = ref<HTMLElement | null>(null);
  const menuEl = ref<HTMLElement | null>(null);
  const scrolledUp = ref(false);
  const canScrollDown = ref(false);
  const thumb = ref<OverlayScrollbarThumb | null>(null);
  const scrollMaxHeight = ref('');
  const showHints = computed(() => options.layout() === 'popup' && options.items().length > 0);
  let resizeObserver: ResizeObserver | null = null;
  let activeThumbCleanup: (() => void) | null = null;

  function updateScrollState(): void {
    const el = scrollEl.value;
    if (!el) return;
    scrolledUp.value = el.scrollTop > 0;
    canScrollDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    const geometry = overlayScrollbarThumb(
      el.scrollTop,
      el.scrollHeight,
      el.clientHeight,
      cssNumber(el, '--menu-scrollbar-track-inset', 0),
      cssNumber(el, '--menu-scrollbar-thumb-min', 24),
    );
    thumb.value = geometry === null ? null : { top: el.offsetTop + geometry.top, height: geometry.height };
  }

  function onScroll(): void {
    updateScrollState();
  }

  function onRowPointerMove(event: PointerEvent, index: number): void {
    if (isSyntheticPointerMove(event)) return;
    options.onHover(index);
  }

  function onMenuMouseDown(event: MouseEvent): void {
    if (options.layout() === 'popup') event.preventDefault();
  }

  function onThumbPointerDown(event: PointerEvent): void {
    const el = scrollEl.value;
    const current = thumb.value;
    if (!el || !current) return;
    activeThumbCleanup?.();
    const stop = dragOverlayScrollbarThumb(event, el, current.height, cssNumber(el, '--menu-scrollbar-track-inset', 0), () => {
      if (activeThumbCleanup === stop) activeThumbCleanup = null;
    });
    activeThumbCleanup = stop;
  }

  const maskImage = computed(() => {
    const up = scrolledUp.value;
    const down = canScrollDown.value;
    const fade = 'var(--menu-scroll-fade)';
    if (up && down) return `linear-gradient(to bottom, transparent 0, black ${fade}, black calc(100% - ${fade}), transparent 100%)`;
    if (up) return `linear-gradient(to bottom, transparent, black ${fade})`;
    if (down) return `linear-gradient(to top, transparent, black ${fade})`;
    return undefined;
  });

  function clampScrollToViewport(): void {
    const menu = menuEl.value;
    const scroll = scrollEl.value;
    const parent = menu?.offsetParent as HTMLElement | null;
    if (!menu || !scroll || !parent) return;
    const menuStyle = getComputedStyle(menu);
    const gap = parseFloat(menuStyle.getPropertyValue('--space-2')) || 8;
    const margin = parseFloat(menuStyle.getPropertyValue('--space-2')) || 8;
    const hints = menu.querySelector<HTMLElement>('.composer-menu-hints');
    const hintsHeight = hints ? hints.offsetHeight + (parseFloat(getComputedStyle(hints).marginTop) || 0) : 0;
    const padding = (parseFloat(menuStyle.paddingTop) || 0) + (parseFloat(menuStyle.paddingBottom) || 0);
    const chrome = padding + hintsHeight + (options.headEl?.value?.offsetHeight ?? 0);
    const cap = parseFloat(getComputedStyle(scroll).getPropertyValue(options.maxHeightVar)) || Number.POSITIVE_INFINITY;
    const viewportTop = window.visualViewport?.offsetTop ?? 0;
    const available = parent.getBoundingClientRect().top - viewportTop - gap - margin - chrome;
    scrollMaxHeight.value = `${Math.max(Math.floor(Math.min(cap, available)), 0)}px`;
    void nextTick(() => {
      updateScrollState();
      scrollActiveIntoView();
    });
  }

  function scrollActiveIntoView(): void {
    const el = scrollEl.value;
    if (!el) return;
    const row = el.querySelectorAll<HTMLElement>('[role="option"]')[options.activeIndex()];
    if (!row) return;
    const elRect = el.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const top = rowRect.top - elRect.top + el.scrollTop;
    const bottom = top + rowRect.height;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }

  function refitPopup(): void {
    if (options.layout() === 'popup') void nextTick(clampScrollToViewport);
  }

  onMounted(() => {
    ensurePointerTracking();
    if (options.layout() === 'sheet') {
      updateScrollState();
      if (typeof ResizeObserver === 'function' && scrollEl.value) {
        resizeObserver = new ResizeObserver(() => updateScrollState());
        resizeObserver.observe(scrollEl.value);
      }
      return;
    }
    clampScrollToViewport();
    updateScrollState();
    if (typeof ResizeObserver === 'function' && scrollEl.value) {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target === scrollEl.value) updateScrollState();
          else clampScrollToViewport();
        }
      });
      resizeObserver.observe(scrollEl.value);
      const parent = menuEl.value?.offsetParent;
      if (parent) resizeObserver.observe(parent);
    }
    window.addEventListener('resize', clampScrollToViewport);
    window.visualViewport?.addEventListener('resize', clampScrollToViewport);
    window.visualViewport?.addEventListener('scroll', clampScrollToViewport);
  });

  onUnmounted(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    activeThumbCleanup?.();
    window.removeEventListener('resize', clampScrollToViewport);
    window.visualViewport?.removeEventListener('resize', clampScrollToViewport);
    window.visualViewport?.removeEventListener('scroll', clampScrollToViewport);
  });

  watch(options.activeIndex, () => {
    void nextTick(scrollActiveIntoView);
  });
  if (options.refitOn) watch(options.refitOn, refitPopup);
  watch(showHints, refitPopup);
  watch(options.contentOn ?? options.items, () => {
    void nextTick(() => {
      updateScrollState();
      scrollActiveIntoView();
    });
  });

  return {
    scrollEl,
    menuEl,
    thumb,
    maskImage,
    scrollMaxHeight,
    showHints,
    onScroll,
    onRowPointerMove,
    onMenuMouseDown,
    onThumbPointerDown,
  };
}

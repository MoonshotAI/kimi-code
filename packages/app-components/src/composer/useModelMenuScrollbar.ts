import { computed, nextTick, ref, watch, type Ref } from 'vue';
import { useOverlayScrollbar } from '@moonshot-ai/app-client/composables';

export function useModelMenuScrollbar(scrollEl: Ref<HTMLElement | null | undefined>) {
  const target = computed(() => scrollEl.value ?? null);
  const scrollbar = useOverlayScrollbar(target);
  const scrolledUp = ref(false);
  const canScrollDown = ref(false);

  function sync(): void {
    const el = target.value;
    scrolledUp.value = (el?.scrollTop ?? 0) > 0;
    canScrollDown.value = el !== null && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    scrollbar.update();
  }

  function onScroll(): void {
    sync();
    scrollbar.markScrolling();
  }

  const maskImage = computed(() => {
    const fade = 'var(--menu-scroll-fade, 20px)';
    if (scrolledUp.value && canScrollDown.value) {
      return `linear-gradient(to bottom, transparent 0, black ${fade}, black calc(100% - ${fade}), transparent 100%)`;
    }
    if (scrolledUp.value) return `linear-gradient(to bottom, transparent, black ${fade})`;
    if (canScrollDown.value) return `linear-gradient(to top, transparent, black ${fade})`;
    return undefined;
  });

  watch(
    target,
    (el, _, onCleanup) => {
      void nextTick(sync);
      if (!el || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(sync);
      observer.observe(el);
      for (const child of el.children) observer.observe(child);
      onCleanup(() => observer.disconnect());
    },
    { immediate: true, flush: 'post' },
  );

  return {
    ...scrollbar,
    maskImage,
    sync,
    onScroll,
  };
}

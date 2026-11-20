import { nextTick, onUnmounted, ref } from 'vue';
import type { SettingsHighlightKey } from './useAppDialogs';

export interface SettingHighlightTarget {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
}

export function useSettingHighlight(options?: {
  beforeHighlight?: (key: SettingsHighlightKey) => void;
}) {
  const runningSendRowRef = ref<SettingHighlightTarget | null>(null);
  const highlightedSetting = ref<SettingsHighlightKey | null>(null);
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSettingHighlight(): void {
    if (highlightTimer !== null) {
      clearTimeout(highlightTimer);
      highlightTimer = null;
    }
    highlightedSetting.value = null;
  }

  function triggerSettingHighlight(key: SettingsHighlightKey | undefined): void {
    clearSettingHighlight();
    if (!key) return;
    options?.beforeHighlight?.(key);
    highlightedSetting.value = key;
    void nextTick(() => {
      const target = key === 'running-send-mode' ? runningSendRowRef.value : null;
      const reducedMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target?.scrollIntoView({
        block: 'center',
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    });
    highlightTimer = setTimeout(() => {
      highlightedSetting.value = null;
      highlightTimer = null;
    }, 2200);
  }

  onUnmounted(clearSettingHighlight);

  return {
    runningSendRowRef,
    highlightedSetting,
    clearSettingHighlight,
    triggerSettingHighlight,
  };
}

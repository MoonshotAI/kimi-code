import { computed, onScopeDispose, ref, watch } from 'vue';
import type { NativeTerminalStore } from './useNativeTerminal';

export function useTerminalActivity(store: Pick<NativeTerminalStore, 'allTabs' | 'inspect'>, options: {
  visibleIds: () => readonly string[];
  intervalMs: number;
}): void {
  const pageVisible = ref(document.visibilityState !== 'hidden');
  const ids = computed(() => {
    if (!pageVisible.value) return [];
    const visible = new Set(options.visibleIds());
    return store.allTabs.value.filter(tab => tab.status === 'running' && visible.has(tab.id)).map(tab => tab.id);
  });
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  const onVisibility = (): void => { pageVisible.value = document.visibilityState !== 'hidden'; };
  document.addEventListener('visibilitychange', onVisibility);
  watch(() => ids.value.join(','), () => {
    const current = ++generation;
    clearTimeout(timer);
    const refresh = (): void => {
      queue = queue.then(async () => {
        if (generation !== current || ids.value.length === 0) return;
        try { await store.inspect([...ids.value]); }
        catch { return; }
        finally {
          if (generation === current) timer = setTimeout(refresh, options.intervalMs);
        }
      });
    };
    if (ids.value.length > 0) refresh();
  }, { immediate: true, flush: 'sync' });
  onScopeDispose(() => {
    generation += 1;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  });
}

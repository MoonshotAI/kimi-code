import { computed, getCurrentScope, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { AppTask } from '@moonshot-ai/app-core/api';

export interface UseTaskClock {
  dispose: () => void;
  tick: Readonly<Ref<number>>;
}

export function useTaskClock(activeAppTasks: ComputedRef<AppTask[]>): UseTaskClock {
  let disposed = false;
  const tick = ref(0);
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopWatch = watch(
    () => activeAppTasks.value.some((tk) => tk.status === 'running'),
    (hasRunning) => {
      if (hasRunning && timer === null) {
        timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          tick.value = (tick.value + 1) % Number.MAX_SAFE_INTEGER;
        }, 1000);
      } else if (!hasRunning && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    { immediate: true },
  );

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopWatch();
    if (timer !== null) clearInterval(timer);
  }

  if (getCurrentScope()) onScopeDispose(dispose);

  return {
    dispose,
    tick: computed(() => tick.value),
  };
}

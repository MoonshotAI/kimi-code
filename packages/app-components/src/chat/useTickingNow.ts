import { ref, watch, type Ref, type WatchSource } from 'vue';

export function useTickingNow(active: WatchSource<boolean>): Ref<number> {
  const now = ref(Date.now());
  watch(
    active,
    (on, _previous, onCleanup) => {
      if (!on) return;
      now.value = Date.now();
      const timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
      onCleanup(() => clearInterval(timer));
    },
    { immediate: true },
  );
  return now;
}

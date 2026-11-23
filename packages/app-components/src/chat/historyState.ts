import { inject, ref, watch, type Ref } from 'vue';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';

export function useHistoryState<T>(key: string, initial: T): Ref<T> {
  const state = inject(HistoryStateKey, undefined);
  const value = ref(state?.has(key) ? state.get(key) : initial) as Ref<T>;
  watch(value, next => state?.set(key, next), { flush: 'sync', deep: true });
  return value;
}

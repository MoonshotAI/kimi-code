import { onScopeDispose, readonly, ref, watch, type Ref } from 'vue';

export const AUTO_REVIEW_HINT_DELAY_MS = 3_000;

export function useAutoReviewHint(reviewing: () => boolean): Readonly<Ref<boolean>> {
  const visible = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  watch(
    reviewing,
    (active) => {
      if (!active) {
        cancel();
        visible.value = false;
        return;
      }
      if (visible.value || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        visible.value = true;
      }, AUTO_REVIEW_HINT_DELAY_MS);
    },
    { immediate: true },
  );
  onScopeDispose(cancel);
  return readonly(visible);
}

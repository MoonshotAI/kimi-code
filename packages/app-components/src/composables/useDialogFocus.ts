import { nextTick, onBeforeUnmount, onMounted, type Ref } from 'vue';

export function useDialogFocus(
  dialogRef: Ref<HTMLElement | null>,
  initialFocus?: Ref<HTMLElement | null>,
): void {
  let previouslyFocused: HTMLElement | null = null;

  onMounted(() => {
    previouslyFocused =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void nextTick(() => {
      const target = initialFocus?.value ?? dialogRef.value;
      try {
        target?.focus();
      } catch {}
    });
  });

  onBeforeUnmount(() => {
    const el = previouslyFocused;
    previouslyFocused = null;
    if (!el || typeof document === 'undefined' || !document.contains(el)) return;
    try {
      el.focus();
    } catch {}
  });
}

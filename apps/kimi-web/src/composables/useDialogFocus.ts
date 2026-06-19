import { nextTick, onBeforeUnmount, onMounted, type Ref } from 'vue';

/**
 * Baseline modal-dialog focus lifecycle, shared by the overlay dialogs so they
 * behave consistently:
 *
 * - records which element had focus before the dialog opened,
 * - moves focus into the dialog on open (an explicit `initialFocus` target if
 *   given, otherwise the dialog root — which should carry `tabindex="-1"`),
 * - restores focus to the opener when the dialog unmounts (i.e. closes).
 *
 * `aria-modal="true"` and Escape-to-close stay in each dialog's template/markup;
 * this composable only owns the focus in/out so that part is not re-implemented
 * (and re-forgotten) per dialog.
 */
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
      } catch {
        // Non-focusable target or jsdom without focus support — ignore.
      }
    });
  });

  onBeforeUnmount(() => {
    const el = previouslyFocused;
    previouslyFocused = null;
    if (!el || typeof document === 'undefined' || !document.contains(el)) return;
    try {
      el.focus();
    } catch {
      // ignore
    }
  });
}

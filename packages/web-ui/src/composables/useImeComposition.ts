import { onUnmounted } from 'vue';

/**
 * IME composition guard for text inputs that commit on Enter (inline rename,
 * path inputs, …). Without it, pressing Enter to confirm an IME candidate
 * (Chinese/Japanese/Korean input) also fires the input's Enter handler and
 * commits prematurely.
 *
 * Safari fires `compositionend` *before* the confirming `keydown` and reports
 * `isComposing === false` on that event, so a plain `e.isComposing` check is
 * not enough — the composition-end flag is held for one macrotask to cover
 * the trailing keydown. `keyCode === 229` catches browsers that only mark the
 * event through the legacy keyCode.
 *
 * Self-healing: browsers may never deliver `compositionend` when the composing
 * input is disconnected mid-composition (e.g. an inline-rename input removed
 * by `v-if` on Escape/blur), which would wedge the guard on for the rest of
 * the component's life. Composition cannot outlive focus, so any focus change
 * is a safe hard reset. `resetComposition` is also exposed for call sites
 * that hide their input on paths of their own.
 *
 * Usage: wire `@compositionstart` / `@compositionend` on the input and bail
 * out of the Enter handler when `isComposingKeyEvent(e)` returns true.
 */
export function useImeComposition(): {
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  resetComposition: () => void;
  isComposingKeyEvent: (e: KeyboardEvent) => boolean;
} {
  let isComposingText = false;
  let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;

  function clearCompositionEndTimer(): void {
    if (compositionEndTimer !== null) {
      clearTimeout(compositionEndTimer);
      compositionEndTimer = null;
    }
  }

  function handleCompositionStart(): void {
    clearCompositionEndTimer();
    isComposingText = true;
  }

  function handleCompositionEnd(): void {
    clearCompositionEndTimer();
    compositionEndTimer = setTimeout(() => {
      compositionEndTimer = null;
      isComposingText = false;
    }, 0);
  }

  function resetComposition(): void {
    clearCompositionEndTimer();
    isComposingText = false;
  }

  function isComposingKeyEvent(e: KeyboardEvent): boolean {
    return isComposingText || e.isComposing || e.keyCode === 229;
  }

  // Capture phase, so a stopPropagation lower in the tree can't hide the focus
  // change from the reset (focusin/focusout do bubble, but callers may stop it).
  if (typeof window !== 'undefined') {
    window.addEventListener('focusin', resetComposition, true);
    window.addEventListener('focusout', resetComposition, true);
  }

  onUnmounted(() => {
    clearCompositionEndTimer();
    if (typeof window !== 'undefined') {
      window.removeEventListener('focusin', resetComposition, true);
      window.removeEventListener('focusout', resetComposition, true);
    }
  });

  return { handleCompositionStart, handleCompositionEnd, resetComposition, isComposingKeyEvent };
}

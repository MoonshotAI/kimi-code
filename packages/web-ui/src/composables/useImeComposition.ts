import { onUnmounted } from 'vue';

/**
 * IME composition guard for text inputs that commit on Enter (inline rename,
 * path inputs, …). Without it, pressing Enter to confirm an IME candidate
 * (Chinese/Japanese/Korean input) also fires the input's Enter handler and
 * commits prematurely.
 *
 * Safari fires `compositionend` *before* the confirming `keydown` and reports
 * `isComposing === false` on that event, so a plain `e.isComposing` check is
 * not enough — the composition-ended state is held for a short wall-clock
 * window to cover the trailing keydown. A window (not just one macrotask) is
 * required because Electron attaches the macOS native IME in the browser
 * process and forwards composition events to the renderer over IPC, so the
 * confirming keydown can arrive several tasks — a few milliseconds — after
 * `compositionend`. `keyCode === 229` catches browsers that only mark the
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

/** How long after `compositionend` a keydown is still treated as part of the
    composition. Far above the browser-process → renderer IPC jitter described
    above, far below the fastest human "confirm candidate, then commit the
    field" double-Enter. */
const COMPOSITION_END_GUARD_MS = 100;

export function useImeComposition(): {
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  resetComposition: () => void;
  isComposingKeyEvent: (e: KeyboardEvent) => boolean;
} {
  let isComposingText = false;
  /** Timestamp of the last `compositionend`; 0 = no recent composition. */
  let compositionEndedAt = 0;

  function handleCompositionStart(): void {
    isComposingText = true;
    compositionEndedAt = 0;
  }

  function handleCompositionEnd(): void {
    isComposingText = false;
    compositionEndedAt = Date.now();
  }

  function resetComposition(): void {
    isComposingText = false;
    compositionEndedAt = 0;
  }

  function isComposingKeyEvent(e: KeyboardEvent): boolean {
    return (
      isComposingText ||
      e.isComposing ||
      e.keyCode === 229 ||
      Date.now() - compositionEndedAt < COMPOSITION_END_GUARD_MS
    );
  }

  // Capture phase, so a stopPropagation lower in the tree can't hide the focus
  // change from the reset (focusin/focusout do bubble, but callers may stop it).
  if (typeof window !== 'undefined') {
    window.addEventListener('focusin', resetComposition, true);
    window.addEventListener('focusout', resetComposition, true);
  }

  onUnmounted(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('focusin', resetComposition, true);
      window.removeEventListener('focusout', resetComposition, true);
    }
  });

  return { handleCompositionStart, handleCompositionEnd, resetComposition, isComposingKeyEvent };
}

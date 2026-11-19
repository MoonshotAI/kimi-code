import { onUnmounted } from 'vue';

const COMPOSITION_END_GUARD_MS = 100;

export function useImeComposition(): {
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  resetComposition: () => void;
  isComposingKeyEvent: (e: KeyboardEvent) => boolean;
} {
  let isComposingText = false;
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

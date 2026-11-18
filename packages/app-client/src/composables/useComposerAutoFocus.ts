import { ref, watch, type Ref } from 'vue';

export interface ComposerFocusHandle {
  focus: () => void;
}

export interface ComposerAutoFocusDeps {
  sessionId: () => string | undefined;
  mobile: () => boolean;
  starting: () => boolean;
  dockedComposer: Ref<ComposerFocusHandle | null>;
  emptyComposer: Ref<ComposerFocusHandle | null>;
}

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    (el as HTMLElement).isContentEditable === true
  );
}

export function useComposerAutoFocus(deps: ComposerAutoFocusDeps): void {
  const { sessionId, mobile, starting, dockedComposer, emptyComposer } = deps;

  const focusPending = ref(false);

  watch(sessionId, () => {
    if (mobile()) return;
    focusPending.value = true;
  });

  watch(
    [focusPending, dockedComposer, emptyComposer, starting],
    () => {
      if (!focusPending.value) return;
      const composer = dockedComposer.value ?? emptyComposer.value;
      if (!composer) return;
      const before = typeof document !== 'undefined' ? document.activeElement : null;
      if (isTextEntry(before)) {
        focusPending.value = false;
        return;
      }
      composer.focus();
      if (typeof document === 'undefined' || document.activeElement !== before) {
        focusPending.value = false;
      }
    },
    { flush: 'post' },
  );
}

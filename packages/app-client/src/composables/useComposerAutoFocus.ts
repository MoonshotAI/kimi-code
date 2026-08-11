// packages/app-client/src/composables/useComposerAutoFocus.ts
import { ref, watch, type Ref } from 'vue';

export interface ComposerFocusHandle {
  focus: () => void;
}

export interface ComposerAutoFocusDeps {
  /** Active session id (getter for reactivity) — a change requests a focus. */
  sessionId: () => string | undefined;
  /** Mobile shell: auto-focus is skipped entirely — it would pop the on-screen
      keyboard over the transcript. */
  mobile: () => boolean;
  /** True while a first prompt is being created + submitted — the composer's
      textarea is disabled then, so focus() is a no-op until this clears. */
  starting: () => boolean;
  /** The docked composer handle (ChatDock), when mounted. */
  dockedComposer: Ref<ComposerFocusHandle | null>;
  /** The empty-session composer handle, when mounted. */
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

/**
 * Focus the composer whenever the active session changes: switching to an
 * existing session, and the draft → message-stream transition after the first
 * send (the empty composer unmounts and the docked one mounts — possibly ticks
 * after sessionId flips, and still disabled while `starting`).
 *
 * The request stays pending until a focus() call actually moves focus, so the
 * late-mounting / late-enabling cases are retried when a composer handle binds
 * or `starting` clears. A request is dropped (not deferred) when focus sits in
 * another text-entry element — terminal, rename input, … — the user is typing
 * there on purpose. Turn end deliberately does NOT refocus: it is a passive
 * event that could steal focus while the user reads or types elsewhere.
 */
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
        // Another input owns focus (or the composer already has it) — don't steal.
        focusPending.value = false;
        return;
      }
      composer.focus();
      // focus() is a silent no-op on a disabled textarea (e.g. while
      // `starting`) — keep the request pending so it lands once the textarea
      // re-enables or the docked composer mounts.
      if (typeof document === 'undefined' || document.activeElement !== before) {
        focusPending.value = false;
      }
    },
    { flush: 'post' },
  );
}

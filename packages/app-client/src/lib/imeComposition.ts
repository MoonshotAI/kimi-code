// Shared IME composition latch for document-level key handlers.
//
// The Composer guards its own keydown with a per-textarea latch plus
// keyCode 229, because some browsers emit trailing key events right after
// compositionend — an Escape with isComposing === false when a candidate is
// cancelled, for example. A document-capture Escape handler (the dock work
// panel's) runs EARLIER than the field's own handler and must apply the
// same test, or it swallows that trailing Escape (preventDefault + closing
// the panel) while the user is only dismissing an IME candidate.
//
// The latch tracks composition events at the document (capture, so no
// intermediate handler can stopPropagation it away), and keeps the
// "composing" window open for one macrotask after compositionend — the same
// trailing window the Composer's per-field latch uses.

let composing = false;
let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function onCompositionStart(): void {
  if (compositionEndTimer !== null) {
    clearTimeout(compositionEndTimer);
    compositionEndTimer = null;
  }
  composing = true;
}

function onCompositionEnd(): void {
  if (compositionEndTimer !== null) clearTimeout(compositionEndTimer);
  compositionEndTimer = setTimeout(() => {
    compositionEndTimer = null;
    composing = false;
  }, 0);
}

/** Install the document-level composition tracking. Idempotent; the two
 *  listeners are cheap enough to leave on for the app's lifetime. */
export function installImeCompositionLatch(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('compositionstart', onCompositionStart, true);
  document.addEventListener('compositionend', onCompositionEnd, true);
}

/** The Composer's isComposingKeyEvent test, for document-level handlers. */
export function isImeKeyEvent(event: KeyboardEvent): boolean {
  return composing || event.isComposing || event.keyCode === 229;
}

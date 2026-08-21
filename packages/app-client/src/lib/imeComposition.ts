// Shared IME composition latch for document-level key handlers.
//
// The Composer guards its own keydown with a per-textarea latch plus
// keyCode 229, because some browsers emit trailing key events right after
// compositionend — an Escape with isComposing === false when a candidate is
// cancelled, for example. A document-capture Escape handler (the dock work
// panel's, the app-level side-panel close) runs EARLIER than the field's own
// handler and must apply the same test, or it swallows that trailing Escape
// (preventDefault + closing the panel) while the user is only dismissing an
// IME candidate.
//
// The latch tracks composition events at the document (capture, so no
// intermediate handler can stopPropagation it away). Two edge cases mirror
// the Composer's per-field guard (packages/app-ui useImeComposition):
//
// - Trailing window: Electron attaches the macOS native IME in the browser
//   process and forwards composition events to the renderer over IPC, so the
//   keydown that follows compositionend can arrive several milliseconds
//   later with isComposing === false. A one-macrotask hold is not enough
//   there — the "composing" window stays open for a short wall-clock window
//   after compositionend.
//
// - Self-healing: a composing input removed mid-composition (v-if on
//   Escape/blur) may never deliver compositionend, which would wedge the
//   latch on and swallow every later Escape. Composition cannot outlive
//   focus, so any focus change hard-resets the latch.

let composing = false;
/** Timestamp of the last compositionend; 0 = no recent composition. */
let compositionEndedAt = 0;
let installed = false;

/** How long after compositionend a keydown is still treated as part of the
    composition — the same window the Composer's per-field guard uses. Far
    above the browser-process → renderer IPC jitter described above, far
    below the fastest human "cancel candidate, then close the panel"
    double-Escape. */
const COMPOSITION_END_GUARD_MS = 100;

function onCompositionStart(): void {
  composing = true;
  compositionEndedAt = 0;
}

function onCompositionEnd(): void {
  composing = false;
  compositionEndedAt = Date.now();
}

function resetComposition(): void {
  composing = false;
  compositionEndedAt = 0;
}

/** Install the document-level composition tracking. Idempotent; the
 *  listeners are cheap enough to leave on for the app's lifetime. */
export function installImeCompositionLatch(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('compositionstart', onCompositionStart, true);
  document.addEventListener('compositionend', onCompositionEnd, true);
  // Capture phase, so a stopPropagation lower in the tree can't hide the
  // focus change from the reset.
  document.addEventListener('focusin', resetComposition, true);
  document.addEventListener('focusout', resetComposition, true);
}

/** The Composer's isComposingKeyEvent test, for document-level handlers. */
export function isImeKeyEvent(event: KeyboardEvent): boolean {
  return (
    composing ||
    event.isComposing ||
    event.keyCode === 229 ||
    Date.now() - compositionEndedAt < COMPOSITION_END_GUARD_MS
  );
}

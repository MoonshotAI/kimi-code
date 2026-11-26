
let composing = false;
let compositionEndedAt = 0;
let installed = false;

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

export function installImeCompositionLatch(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('compositionstart', onCompositionStart, true);
  document.addEventListener('compositionend', onCompositionEnd, true);
  document.addEventListener('focusin', resetComposition, true);
  document.addEventListener('focusout', resetComposition, true);
}

export function isImeKeyEvent(event: KeyboardEvent): boolean {
  return (
    composing ||
    event.isComposing ||
    // oxlint-disable-next-line typescript/no-deprecated -- Chromium/Safari IME composition still reports keyCode 229
    event.keyCode === 229 ||
    Date.now() - compositionEndedAt < COMPOSITION_END_GUARD_MS
  );
}

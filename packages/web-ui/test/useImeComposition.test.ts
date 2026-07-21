import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useImeComposition } from '../src/composables/useImeComposition';

// The composable registers onUnmounted, which is a no-op without an active
// component instance — silence Vue's warning for these unit tests.
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function keyEvent(init: { isComposing?: boolean; keyCode?: number }): KeyboardEvent {
  return init as KeyboardEvent;
}

describe('useImeComposition', () => {
  it('lets a plain Enter through when no IME is active', () => {
    const { isComposingKeyEvent } = useImeComposition();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it('blocks keys while a composition is in progress', () => {
    const { handleCompositionStart, isComposingKeyEvent } = useImeComposition();
    handleCompositionStart();
    expect(isComposingKeyEvent(keyEvent({ isComposing: true, keyCode: 229 }))).toBe(true);
    // Even an event the browser forgot to flag is blocked by the tracked state.
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true);
  });

  it('keeps blocking the candidate-confirming keydown that follows compositionend', () => {
    const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } =
      useImeComposition();
    handleCompositionStart();
    // Safari fires compositionend *before* the confirming keydown and reports
    // isComposing === false on it — the guard must outlive that one keydown.
    handleCompositionEnd();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true);
    // One macrotask later the guard lifts and the next real Enter commits.
    vi.advanceTimersByTime(1);
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it('treats legacy keyCode 229 as composing without any composition events', () => {
    const { isComposingKeyEvent } = useImeComposition();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 229 }))).toBe(true);
  });

  it('recovers via resetComposition when compositionend never fires', () => {
    const { handleCompositionStart, resetComposition, isComposingKeyEvent } = useImeComposition();
    handleCompositionStart();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true);
    // The input was removed mid-composition and the browser skipped
    // compositionend — the guard must not stay wedged on.
    resetComposition();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it('self-heals on focus changes when window is available', () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: () => {},
    });
    const { handleCompositionStart, isComposingKeyEvent } = useImeComposition();
    handleCompositionStart();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true);
    // Composition cannot outlive focus: a blur elsewhere resets a wedged guard.
    listeners.get('focusout')?.();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });
});

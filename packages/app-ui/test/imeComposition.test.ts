import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CompositionHandler = () => void;

function stubDocument(): {
  fire: (type: 'compositionstart' | 'compositionend' | 'focusin' | 'focusout') => void;
  listenerCount: (type: string) => number;
} {
  const listeners = new Map<string, CompositionHandler[]>();
  vi.stubGlobal('document', {
    addEventListener: (type: string, fn: CompositionHandler) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
  });
  return {
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

function escapeKey(init: { isComposing?: boolean; keyCode?: number } = {}): KeyboardEvent {
  return { isComposing: false, keyCode: 27, ...init } as KeyboardEvent;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('installImeCompositionLatch / isImeKeyEvent', () => {
  it('lets a plain Escape through when no IME composition is active', async () => {
    stubDocument();
    const { installImeCompositionLatch, isImeKeyEvent } = await import('../src/composables/imeComposition');
    installImeCompositionLatch();
    expect(isImeKeyEvent(escapeKey())).toBe(false);
  });

  it('is idempotent — a second install adds no more listeners', async () => {
    const doc = stubDocument();
    const { installImeCompositionLatch } = await import('../src/composables/imeComposition');
    installImeCompositionLatch();
    installImeCompositionLatch();
    expect(doc.listenerCount('compositionstart')).toBe(1);
    expect(doc.listenerCount('compositionend')).toBe(1);
    expect(doc.listenerCount('focusin')).toBe(1);
    expect(doc.listenerCount('focusout')).toBe(1);
  });

  it('claims Escape while a composition is active, even when the browser leaves it unflagged', async () => {
    const doc = stubDocument();
    const { installImeCompositionLatch, isImeKeyEvent } = await import('../src/composables/imeComposition');
    installImeCompositionLatch();
    doc.fire('compositionstart');
    expect(isImeKeyEvent(escapeKey())).toBe(true);
  });

  it('keeps claiming the trailing Escape within a 100ms window after compositionend', async () => {
    const doc = stubDocument();
    const { installImeCompositionLatch, isImeKeyEvent } = await import('../src/composables/imeComposition');
    installImeCompositionLatch();
    doc.fire('compositionstart');
    doc.fire('compositionend');
    expect(isImeKeyEvent(escapeKey())).toBe(true);
    vi.advanceTimersByTime(50);
    expect(isImeKeyEvent(escapeKey())).toBe(true);
    vi.advanceTimersByTime(100);
    expect(isImeKeyEvent(escapeKey())).toBe(false);
  });

  it('self-heals on any focus change when compositionend never arrives', async () => {
    const doc = stubDocument();
    const { installImeCompositionLatch, isImeKeyEvent } = await import('../src/composables/imeComposition');
    installImeCompositionLatch();
    doc.fire('compositionstart');
    expect(isImeKeyEvent(escapeKey())).toBe(true);
    doc.fire('focusout');
    expect(isImeKeyEvent(escapeKey())).toBe(false);
  });

  it('claims Escape on the event flags alone (isComposing / legacy keyCode 229)', async () => {
    stubDocument();
    const { isImeKeyEvent } = await import('../src/composables/imeComposition');
    expect(isImeKeyEvent(escapeKey({ isComposing: true }))).toBe(true);
    expect(isImeKeyEvent(escapeKey({ keyCode: 229 }))).toBe(true);
  });
});

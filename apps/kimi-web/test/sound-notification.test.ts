import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS, safeGetString } from '../src/lib/storage';
import { useSoundNotification } from '../src/composables/client/useSoundNotification';

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys()).at(index) ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

// Singleton — module-level ref + setter. Audio unlock/listeners are no-ops here
// because the test env has no `window`.
const { soundOnComplete, setSoundOnComplete, maybePlayQuestionSound } = useSoundNotification();
// Captured at import (before beforeEach resets the ref), so this reflects the
// load-from-storage default when nothing has been stored yet.
const importedDefault = soundOnComplete.value;

describe('useSoundNotification', () => {
  beforeEach(() => {
    installStorage(createMemoryStorage());
    setSoundOnComplete(true); // reset the shared singleton to a known state
  });

  afterEach(() => {
    installStorage(createMemoryStorage());
  });

  it('persists "0" and updates the ref when disabled', () => {
    setSoundOnComplete(false);
    expect(soundOnComplete.value).toBe(false);
    expect(safeGetString(STORAGE_KEYS.soundOnComplete)).toBe('0');
  });

  it('persists "1" and updates the ref when re-enabled', () => {
    setSoundOnComplete(false);
    setSoundOnComplete(true);
    expect(soundOnComplete.value).toBe(true);
    expect(safeGetString(STORAGE_KEYS.soundOnComplete)).toBe('1');
  });

  it('defaults to off when nothing is stored', () => {
    expect(importedDefault).toBe(false);
  });

  it('maybePlayQuestionSound is a no-op without throwing when audio is unavailable', () => {
    expect(() => {
      maybePlayQuestionSound();
    }).not.toThrow();
  });
});

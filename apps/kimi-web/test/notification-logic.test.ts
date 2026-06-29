import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS, safeGetString } from '../src/lib/storage';
import { useNotification } from '../src/composables/client/useNotification';

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

// Singleton — module-level refs + setters. The OS Notification API is absent in
// the test env, so the *enable* path is a no-op; the disable path and the
// load-from-storage defaults are what we exercise here.
const { notifyOnComplete, notifyOnQuestion, setNotifyOnComplete, setNotifyOnQuestion } = useNotification();
// Captured at import (before beforeEach touches the refs), so these reflect the
// load-from-storage defaults when nothing has been stored yet.
const importedCompleteDefault = notifyOnComplete.value;
const importedQuestionDefault = notifyOnQuestion.value;

describe('useNotification preferences', () => {
  beforeEach(() => {
    installStorage(createMemoryStorage());
  });

  afterEach(() => {
    installStorage(createMemoryStorage());
  });

  it('completion notifications default to on', () => {
    expect(importedCompleteDefault).toBe(true);
  });

  it('question notifications default to off so question text stays behind an explicit opt-in', () => {
    expect(importedQuestionDefault).toBe(false);
  });

  it('disabling question notifications persists "0" and updates the ref', () => {
    void setNotifyOnQuestion(false);
    expect(notifyOnQuestion.value).toBe(false);
    expect(safeGetString(STORAGE_KEYS.notifyOnQuestion)).toBe('0');
  });

  it('disabling completion notifications persists "0" and updates the ref', () => {
    void setNotifyOnComplete(false);
    expect(notifyOnComplete.value).toBe(false);
    expect(safeGetString(STORAGE_KEYS.notifyOnComplete)).toBe('0');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

// The two message-fold switches are module-level singletons that read
// localStorage once at import time, so every test resets the module registry
// and stubs storage before importing.

function stubStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (map.has(key) ? map.get(key) : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  });
  return map;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('useTurnFolding', () => {
  it('defaults OFF when storage is empty', async () => {
    stubStorage();
    const { useTurnFolding } = await import('../src/composables/useTurnFolding');
    expect(useTurnFolding().turnFolding.value).toBe(false);
  });

  it("reads a stored '1' as on", async () => {
    stubStorage({ 'kimi-web.turn-folding': '1' });
    const { useTurnFolding } = await import('../src/composables/useTurnFolding');
    expect(useTurnFolding().turnFolding.value).toBe(true);
  });

  it('persists the setter and survives a remount', async () => {
    const map = stubStorage();
    const { useTurnFolding } = await import('../src/composables/useTurnFolding');
    useTurnFolding().setTurnFolding(true);
    expect(useTurnFolding().turnFolding.value).toBe(true);
    expect(map.get('kimi-web.turn-folding')).toBe('1');
    useTurnFolding().setTurnFolding(false);
    expect(map.get('kimi-web.turn-folding')).toBe('0');
  });

  it('falls back to the default when storage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const { useTurnFolding } = await import('../src/composables/useTurnFolding');
    expect(useTurnFolding().turnFolding.value).toBe(false);
    expect(() => useTurnFolding().setTurnFolding(true)).not.toThrow();
  });
});

describe('useActivityRunFolding', () => {
  it('defaults ON when storage is empty', async () => {
    stubStorage();
    const { useActivityRunFolding } = await import('../src/composables/useActivityRunFolding');
    expect(useActivityRunFolding().activityRunFolding.value).toBe(true);
  });

  it("reads a stored '0' as off", async () => {
    stubStorage({ 'kimi-web.activity-run-folding': '0' });
    const { useActivityRunFolding } = await import('../src/composables/useActivityRunFolding');
    expect(useActivityRunFolding().activityRunFolding.value).toBe(false);
  });

  it('persists the setter', async () => {
    const map = stubStorage();
    const { useActivityRunFolding } = await import('../src/composables/useActivityRunFolding');
    useActivityRunFolding().setActivityRunFolding(false);
    expect(useActivityRunFolding().activityRunFolding.value).toBe(false);
    expect(map.get('kimi-web.activity-run-folding')).toBe('0');
  });
});

describe('the two switches are independent', () => {
  it('setting one leaves the other at its default and uses its own key', async () => {
    const map = stubStorage();
    const { useTurnFolding } = await import('../src/composables/useTurnFolding');
    const { useActivityRunFolding } = await import('../src/composables/useActivityRunFolding');
    useTurnFolding().setTurnFolding(true);
    expect(useActivityRunFolding().activityRunFolding.value).toBe(true);
    expect(map.has('kimi-web.activity-run-folding')).toBe(false);
    useActivityRunFolding().setActivityRunFolding(false);
    expect(useTurnFolding().turnFolding.value).toBe(true);
    expect(map.get('kimi-web.turn-folding')).toBe('1');
    expect(map.get('kimi-web.activity-run-folding')).toBe('0');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY_MODE = 'kimi-web.running-send-mode';
const KEY_TIP = 'kimi-web.running-send-steer-tip-seen';

function stubStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  });
  return map;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('useRunningSendMode', () => {
  it('defaults to steer when storage is empty', async () => {
    stubStorage();
    const { useRunningSendMode } = await import('../src/composables/useRunningSendMode');
    const state = useRunningSendMode();
    expect(state.runningSendMode.value).toBe('steer');
    expect(state.runningSendTipVisible.value).toBe(false);
  });

  it('reads stored queue and steer values and falls back to steer for invalid values', async () => {
    stubStorage({ [KEY_MODE]: 'queue' });
    const queued = await import('../src/composables/useRunningSendMode');
    expect(queued.useRunningSendMode().runningSendMode.value).toBe('queue');

    vi.resetModules();
    stubStorage({ [KEY_MODE]: 'steer' });
    const steered = await import('../src/composables/useRunningSendMode');
    expect(steered.useRunningSendMode().runningSendMode.value).toBe('steer');

    for (const invalid of ['', 'auto', '1', '0', 'STEER']) {
      vi.resetModules();
      stubStorage({ [KEY_MODE]: invalid });
      const fallback = await import('../src/composables/useRunningSendMode');
      expect(fallback.useRunningSendMode().runningSendMode.value).toBe('steer');
    }
  });

  it('shows the composer tip only on the first default-steer trigger and persists dismissal across reloads', async () => {
    const map = stubStorage();
    const first = await import('../src/composables/useRunningSendMode');
    const state = first.useRunningSendMode();

    state.noteDefaultRunningSteerTriggered();
    expect(state.runningSendTipVisible.value).toBe(true);
    expect(map.get(KEY_TIP)).toBe('1');

    state.dismissRunningSendTip();
    expect(state.runningSendTipVisible.value).toBe(false);

    state.noteDefaultRunningSteerTriggered();
    expect(state.runningSendTipVisible.value).toBe(false);

    vi.resetModules();
    const reloaded = await import('../src/composables/useRunningSendMode');
    const afterReload = reloaded.useRunningSendMode();
    expect(afterReload.runningSendTipVisible.value).toBe(false);
    afterReload.noteDefaultRunningSteerTriggered();
    expect(afterReload.runningSendTipVisible.value).toBe(false);
  });

  it('skips the tip if the user already explicitly saved a mode', async () => {
    stubStorage({ [KEY_MODE]: 'steer' });
    const { useRunningSendMode } = await import('../src/composables/useRunningSendMode');
    const state = useRunningSendMode();
    state.noteDefaultRunningSteerTriggered();
    expect(state.runningSendTipVisible.value).toBe(false);
  });

  it('changing the setting dismisses an open tip and persists the mode', async () => {
    const map = stubStorage();
    const { useRunningSendMode } = await import('../src/composables/useRunningSendMode');
    const state = useRunningSendMode();
    state.noteDefaultRunningSteerTriggered();
    expect(state.runningSendTipVisible.value).toBe(true);

    state.setRunningSendMode('queue');
    expect(state.runningSendMode.value).toBe('queue');
    expect(state.runningSendTipVisible.value).toBe(false);
    expect(map.get(KEY_MODE)).toBe('queue');
    expect(map.get(KEY_TIP)).toBe('1');

    vi.resetModules();
    const reloaded = await import('../src/composables/useRunningSendMode');
    expect(reloaded.useRunningSendMode().runningSendMode.value).toBe('queue');
  });

  it('degrades gracefully when localStorage throws and still only shows the tip once in memory', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const { useRunningSendMode } = await import('../src/composables/useRunningSendMode');
    const state = useRunningSendMode();
    expect(state.runningSendMode.value).toBe('steer');
    expect(() => state.noteDefaultRunningSteerTriggered()).not.toThrow();
    expect(state.runningSendTipVisible.value).toBe(true);
    state.dismissRunningSendTip();
    state.noteDefaultRunningSteerTriggered();
    expect(state.runningSendTipVisible.value).toBe(false);
  });
});

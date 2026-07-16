import { describe, expect, it, vi } from 'vitest';

import { createFullscreenTracker } from './useFullscreen';

// Two microtask flushes: the tracker's .then runs after the bridge promise
// resolves, so a single await can race depending on the mock's resolution path.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function fakeBridge(initial: boolean) {
  const listeners = new Set<(fullscreen: boolean) => void>();
  const emit = (fullscreen: boolean): void => {
    listeners.forEach((cb) => cb(fullscreen));
  };
  return {
    bridge: {
      isFullscreen: vi.fn().mockResolvedValue(initial),
      onFullscreenChanged: vi.fn((cb: (fullscreen: boolean) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }),
    },
    emit,
  };
}

describe('createFullscreenTracker', () => {
  it('stays false with no desktop bridge (web / no-bridge fallback)', async () => {
    const isFullscreen = createFullscreenTracker(undefined);
    await flush();
    expect(isFullscreen.value).toBe(false);
  });

  it('adopts the initial bridge state once the query resolves', async () => {
    const { bridge } = fakeBridge(true);
    const isFullscreen = createFullscreenTracker(bridge);
    expect(isFullscreen.value).toBe(false); // async: not yet resolved
    await flush();
    expect(isFullscreen.value).toBe(true);
  });

  it('follows pushed enter/leave transitions', async () => {
    const { bridge, emit } = fakeBridge(false);
    const isFullscreen = createFullscreenTracker(bridge);
    await flush();
    emit(true);
    expect(isFullscreen.value).toBe(true);
    emit(false);
    expect(isFullscreen.value).toBe(false);
  });

  it('keeps the non-fullscreen layout when the bridge query rejects', async () => {
    const bridge = {
      isFullscreen: vi.fn().mockRejectedValue(new Error('bridge gone')),
      onFullscreenChanged: vi.fn(() => () => {}),
    };
    const isFullscreen = createFullscreenTracker(bridge);
    await flush();
    expect(isFullscreen.value).toBe(false);
  });
});

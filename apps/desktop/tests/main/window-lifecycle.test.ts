import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('window lifecycle telemetry state', () => {
  it('replays a state recorded before telemetry was wired', async () => {
    const track = vi.fn();
    const lifecycle = await import('../../src/main/window-lifecycle');
    const { setDesktopTrackImpl } = await import('../../src/main/track');

    lifecycle.recordWindowLifecycle('shown');
    setDesktopTrackImpl(track);
    lifecycle.replayWindowLifecycle();

    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith('window_lifecycle', { action: 'shown' });
    setDesktopTrackImpl(null);
  });

  it('deduplicates repeated transitions and finalizes only once', async () => {
    const track = vi.fn();
    const lifecycle = await import('../../src/main/window-lifecycle');
    const { setDesktopTrackImpl } = await import('../../src/main/track');
    setDesktopTrackImpl(track);

    lifecycle.recordWindowLifecycle('shown');
    lifecycle.recordWindowLifecycle('shown');
    lifecycle.finalizeWindowLifecycle();
    lifecycle.recordWindowLifecycle('closed');
    lifecycle.finalizeWindowLifecycle();

    expect(track.mock.calls).toEqual([
      ['window_lifecycle', { action: 'shown' }],
      ['window_lifecycle', { action: 'closed' }],
    ]);
    setDesktopTrackImpl(null);
  });
});

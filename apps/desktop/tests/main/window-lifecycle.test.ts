import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('window lifecycle telemetry state', () => {
  it('buffers a state recorded before telemetry was wired and replays it on wiring', async () => {
    const track = vi.fn();
    const lifecycle = await import('../../src/main/window-lifecycle');
    const { setDesktopTrackImpl } = await import('../../src/main/track');

    lifecycle.recordWindowLifecycle('shown');
    setDesktopTrackImpl(track);

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
      [
        'window_lifecycle',
        { action: 'closed', reason: 'quit', visible_duration_ms: expect.any(Number) },
      ],
    ]);
    setDesktopTrackImpl(null);
  });

  it('carries the reason and the visible time since the last shown on hidden/closed', async () => {
    vi.useFakeTimers();
    try {
      const track = vi.fn();
      const lifecycle = await import('../../src/main/window-lifecycle');
      const { setDesktopTrackImpl } = await import('../../src/main/track');
      setDesktopTrackImpl(track);

      lifecycle.recordWindowLifecycle('shown');
      vi.advanceTimersByTime(1_500);
      lifecycle.recordWindowLifecycle('hidden', { reason: 'close_to_tray' });
      lifecycle.recordWindowLifecycle('shown');
      vi.advanceTimersByTime(250);
      // A plain hide carries no reason.
      lifecycle.recordWindowLifecycle('hidden');

      expect(track.mock.calls).toEqual([
        ['window_lifecycle', { action: 'shown' }],
        [
          'window_lifecycle',
          { action: 'hidden', reason: 'close_to_tray', visible_duration_ms: 1_500 },
        ],
        ['window_lifecycle', { action: 'shown' }],
        ['window_lifecycle', { action: 'hidden', visible_duration_ms: 250 }],
      ]);
      setDesktopTrackImpl(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits visible_duration_ms when nothing was ever shown', async () => {
    const track = vi.fn();
    const lifecycle = await import('../../src/main/window-lifecycle');
    const { setDesktopTrackImpl } = await import('../../src/main/track');
    setDesktopTrackImpl(track);

    lifecycle.recordWindowLifecycle('hidden', { reason: 'deactivate' });

    expect(track).toHaveBeenCalledWith('window_lifecycle', {
      action: 'hidden',
      reason: 'deactivate',
    });
    setDesktopTrackImpl(null);
  });
});

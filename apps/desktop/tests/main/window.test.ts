import { describe, it, expect, vi } from 'vitest';

import {
  clampBoundsToWorkArea,
  drainLaunchActions,
  installWindowsSessionEndWatch,
  isAppRendererUrl,
  looksMaximizedBounds,
  shouldHideOnClose,
  shouldPersistBounds,
  titleBarWindowOptions,
  vibrancyWindowOptions,
} from '../../src/main/window';

describe('titleBarWindowOptions', () => {
  it('uses Window Controls Overlay only on Windows', () => {
    expect(titleBarWindowOptions('win32', false)).toMatchObject({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#202020', height: 40 },
    });
    expect(titleBarWindowOptions('win32', true)).toMatchObject({
      titleBarOverlay: { symbolColor: '#f2f2f2' },
    });
    expect(titleBarWindowOptions('darwin')).toMatchObject({
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 17 },
    });
    expect(titleBarWindowOptions('linux')).toEqual({ titleBarStyle: 'default' });
  });
});

describe('isAppRendererUrl', () => {
  it('accepts the packaged renderer protocol and the dev-server http URL', () => {
    expect(isAppRendererUrl('app://renderer/index.html')).toBe(true);
    expect(isAppRendererUrl('app://renderer/sessions/session_abc')).toBe(true);
    expect(isAppRendererUrl('http://127.0.0.1:5174/')).toBe(true);
    expect(isAppRendererUrl('https://127.0.0.1:5174/')).toBe(true);
  });

  it('rejects pages without a tray-select subscription (error page, blank)', () => {
    expect(isAppRendererUrl('data:text/html;charset=utf-8,%3C!doctype%20html%3E')).toBe(false);
    expect(isAppRendererUrl('about:blank')).toBe(false);
    expect(isAppRendererUrl('')).toBe(false);
  });
});

describe('shouldHideOnClose', () => {
  it('hides instead of destroying on macOS and Windows (tray-resident model)', () => {
    expect(shouldHideOnClose('darwin', false)).toBe(true);
    expect(shouldHideOnClose('win32', false)).toBe(true);
  });

  it('lets real quits destroy the window', () => {
    expect(shouldHideOnClose('darwin', true)).toBe(false);
    expect(shouldHideOnClose('win32', true)).toBe(false);
  });

  it('keeps destroy-on-close on other platforms', () => {
    expect(shouldHideOnClose('linux', false)).toBe(false);
  });
});

describe('installWindowsSessionEndWatch', () => {
  it('marks only the final Windows session-end event as quitting', () => {
    const listeners = new Map<string, () => void>();
    const markEnding = vi.fn();
    installWindowsSessionEndWatch(
      'win32',
      { on: (event, listener) => listeners.set(event, listener) },
      markEnding,
    );

    expect(listeners.has('query-session-end')).toBe(false);
    listeners.get('session-end')?.();
    expect(markEnding).toHaveBeenCalledOnce();
  });

  it('does not install Windows session listeners on other platforms', () => {
    const on = vi.fn();
    installWindowsSessionEndWatch('darwin', { on }, vi.fn());
    expect(on).not.toHaveBeenCalled();
  });
});

describe('drainLaunchActions', () => {
  it('preserves every queued launch action in order and empties the queue', () => {
    const actions = [
      { action: 'new-chat' as const },
      { action: 'open-workspace' as const, root: 'C:\\workspace' },
    ];
    expect(drainLaunchActions(actions)).toEqual([
      { action: 'new-chat' },
      { action: 'open-workspace', root: 'C:\\workspace' },
    ]);
    expect(actions).toEqual([]);
  });
});

describe('shouldPersistBounds', () => {
  it('persists normal window bounds', () => {
    expect(shouldPersistBounds(false, false)).toBe(true);
  });

  it('never persists a maximized or full-screen size (would restore as a fake full screen)', () => {
    expect(shouldPersistBounds(true, false)).toBe(false);
    expect(shouldPersistBounds(false, true)).toBe(false);
    expect(shouldPersistBounds(true, true)).toBe(false);
  });
});

describe('looksMaximizedBounds', () => {
  it('flags bounds that (nearly) fill the display work area', () => {
    const workArea = { width: 1512, height: 944 };
    expect(looksMaximizedBounds({ width: 1512, height: 944 }, workArea)).toBe(true);
    expect(looksMaximizedBounds({ width: 1450, height: 900 }, workArea)).toBe(true);
  });

  it('passes normal window bounds', () => {
    const workArea = { width: 1512, height: 944 };
    expect(looksMaximizedBounds({ width: 1280, height: 860 }, workArea)).toBe(false);
    expect(looksMaximizedBounds({ width: 900, height: 600 }, workArea)).toBe(false);
  });
});

describe('clampBoundsToWorkArea', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

  it('leaves on-screen bounds untouched (same reference)', () => {
    const bounds = { width: 1280, height: 860, x: 100, y: 80 };
    expect(clampBoundsToWorkArea(bounds, workArea)).toBe(bounds);
  });

  it('leaves position-less bounds untouched', () => {
    const bounds = { width: 1280, height: 860 };
    expect(clampBoundsToWorkArea(bounds, workArea)).toBe(bounds);
  });

  it('pulls a fully off-screen window (unplugged monitor) back onto the work area', () => {
    const clamped = clampBoundsToWorkArea({ width: 1280, height: 860, x: 3000, y: 400 }, workArea);
    expect(clamped.x).toBe(1920 - 100);
    expect(clamped.y).toBe(400);
  });

  it('pulls a window parked left of the work area back (keeps 100px visible)', () => {
    const clamped = clampBoundsToWorkArea({ width: 1280, height: 860, x: -2000, y: 100 }, workArea);
    expect(clamped.x).toBe(-1280 + 100);
  });

  it('never lets the title bar go above the work area', () => {
    const clamped = clampBoundsToWorkArea({ width: 1280, height: 860, x: 200, y: -300 }, workArea);
    expect(clamped.y).toBe(0);
  });

  it('clamps a window sunk below the work area', () => {
    const clamped = clampBoundsToWorkArea({ width: 1280, height: 860, x: 200, y: 2000 }, workArea);
    expect(clamped.y).toBe(1080 - 100);
  });

  it('respects a non-zero work area origin (secondary display)', () => {
    const secondary = { x: -2560, y: 30, width: 2560, height: 1410 };
    const bounds = { width: 1280, height: 860, x: -2400, y: 100 };
    expect(clampBoundsToWorkArea(bounds, secondary)).toBe(bounds);
  });
});

describe('vibrancyWindowOptions', () => {
  it('always passes the pinned flat material + transparent flash on macOS (an opt-out launch removes it right after creation)', () => {
    expect(vibrancyWindowOptions('darwin')).toEqual({
      vibrancy: 'menu',
      visualEffectState: 'inactive',
      backgroundColor: '#00000000',
    });
  });

  it('passes no vibrancy options off macOS', () => {
    expect(vibrancyWindowOptions('win32')).toEqual({ backgroundColor: '#0b0b0c' });
    expect(vibrancyWindowOptions('linux')).toEqual({ backgroundColor: '#0b0b0c' });
  });
});

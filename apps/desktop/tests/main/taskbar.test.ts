import { describe, it, expect } from 'vitest';
import type { NativeImage } from 'electron';

import {
  badgePixels,
  badgeText,
  createTaskbarAttention,
  type TaskbarWindowLike,
} from '../../src/main/taskbar';

// Sentinel stand-in for a NativeImage — the controller only passes it through
// to setOverlayIcon.
const BADGE = { id: 'badge' } as unknown as NativeImage;
const badgeFactory = () => BADGE;

interface MockWindow {
  win: TaskbarWindowLike;
  calls: {
    overlays: Array<{ icon: NativeImage | null; description: string }>;
    flashes: boolean[];
    focusListeners: Array<() => void>;
  };
  state: { focused: boolean; destroyed: boolean };
}

function mockWindow(): MockWindow {
  const state = { focused: true, destroyed: false };
  const calls: MockWindow['calls'] = { overlays: [], flashes: [], focusListeners: [] };
  return {
    state,
    calls,
    win: {
      isDestroyed: () => state.destroyed,
      isFocused: () => state.focused,
      setOverlayIcon: (icon, description) => {
        calls.overlays.push({ icon, description });
      },
      flashFrame: (flag) => {
        calls.flashes.push(flag);
      },
      on: (_event, listener) => {
        calls.focusListeners.push(listener);
      },
    },
  };
}

describe('badgePixels', () => {
  it('returns a size*size*4 BGRA buffer', () => {
    expect(badgePixels(16, 1).length).toBe(16 * 16 * 4);
  });

  it('paints an opaque red background and opaque white numeral', () => {
    const pixels = badgePixels(16, 1);
    const red = (4 * 16 + 8) * 4;
    expect([...pixels.subarray(red, red + 4)]).toEqual([0x4d, 0x48, 0xe5, 255]);
    const white = (5 * 16 + 7) * 4;
    expect([...pixels.subarray(white, white + 4)]).toEqual([255, 255, 255, 255]);
  });

  it('leaves the corners fully transparent', () => {
    const pixels = badgePixels(16, 1);
    expect(pixels[3]).toBe(0); // top-left alpha
    const topRight = 15 * 4;
    expect(pixels[topRight + 3]).toBe(0);
    const bottomLeft = (15 * 16) * 4;
    expect(pixels[bottomLeft + 3]).toBe(0);
  });

  it('renders distinct numeric bitmaps and keeps zero fully transparent', () => {
    expect(badgePixels(16, 2).equals(badgePixels(16, 8))).toBe(false);
    expect(badgePixels(16, 0).every((byte) => byte === 0)).toBe(true);
  });
});

describe('badgeText', () => {
  it('formats taskbar counts in the compact 1-99 / 99+ range', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(1)).toBe('1');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});

describe('createTaskbarAttention', () => {
  it('sets the overlay badge with the description while attention pends', () => {
    const { win, calls } = mockWindow();
    const controller = createTaskbarAttention(win, badgeFactory);
    controller.update(3, '3 unread');
    expect(calls.overlays).toEqual([{ icon: BADGE, description: '3 unread' }]);
  });

  it('refreshes the overlay description without flashing when only the locale changes', () => {
    const { win, calls, state } = mockWindow();
    state.focused = false;
    const controller = createTaskbarAttention(win, badgeFactory);
    controller.update(3, '3 unread');
    controller.update(3, '3 条未读');
    expect(calls.overlays).toEqual([
      { icon: BADGE, description: '3 unread' },
      { icon: BADGE, description: '3 条未读' },
    ]);
    expect(calls.flashes).toEqual([]);
  });

  it('clears the overlay when caught up', () => {
    const { win, calls } = mockWindow();
    const controller = createTaskbarAttention(win, badgeFactory);
    controller.update(3, '3 unread');
    controller.update(0, '');
    expect(calls.overlays[1]).toEqual({ icon: null, description: '' });
  });

  it('clears any stale overlay when badge rendering fails (flash-only degrade)', () => {
    const { win, calls } = mockWindow();
    const controller = createTaskbarAttention(win, () => null);
    controller.update(3, '3 unread');
    controller.update(0, '');
    expect(calls.overlays).toEqual([
      { icon: null, description: '' },
      { icon: null, description: '' },
    ]);
  });

  it('uses the first update as a baseline without flashing', () => {
    const { win, calls, state } = mockWindow();
    state.focused = false;
    const controller = createTaskbarAttention(win, badgeFactory);
    controller.update(1, '1 unread');
    expect(calls.flashes).toEqual([]);
  });

  it('flashes when the total grows after the baseline while unfocused', () => {
    const { win, calls, state } = mockWindow();
    state.focused = false;
    const controller = createTaskbarAttention(win, badgeFactory);
    controller.update(1, '1 unread');
    controller.update(2, '2 unread');
    expect(calls.flashes).toEqual([true]);
  });

  it('does not flash while the window is focused', () => {
    const { win, calls } = mockWindow();
    const controller = createTaskbarAttention(win, badgeFactory);
    controller.update(1, '1 unread');
    controller.update(2, '2 unread');
    expect(calls.flashes).toEqual([]);
  });

  it('does not re-flash on an unchanged or shrinking total', () => {
    const { win, calls, state } = mockWindow();
    state.focused = false;
    const controller = createTaskbarAttention(win, badgeFactory);
    controller.update(2, '2 unread');
    controller.update(2, '2 unread');
    controller.update(1, '1 unread');
    expect(calls.flashes).toEqual([]);
  });

  it('stops flashing when the total reaches zero', () => {
    const { win, calls, state } = mockWindow();
    state.focused = false;
    const controller = createTaskbarAttention(win, badgeFactory);
    controller.update(1, '1 unread');
    controller.update(2, '2 unread');
    controller.update(0, '');
    expect(calls.flashes).toEqual([true, false]);
  });

  it('stops flashing on window focus', () => {
    const { win, calls, state } = mockWindow();
    state.focused = false;
    const controller = createTaskbarAttention(win, badgeFactory);
    controller.update(1, '1 unread');
    controller.update(2, '2 unread');
    calls.focusListeners.forEach((listener) => listener());
    expect(calls.flashes).toEqual([true, false]);
  });

  it('ignores updates after the window is destroyed', () => {
    const { win, calls, state } = mockWindow();
    const controller = createTaskbarAttention(win, badgeFactory);
    state.destroyed = true;
    controller.update(1, '1 unread');
    expect(calls.overlays).toEqual([]);
    expect(calls.flashes).toEqual([]);
  });
});

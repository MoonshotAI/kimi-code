import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import type { Input, WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMainWindowZoomLevel, setMainWindowZoomLevel } from '../../../src/main/app/ui-state';
import {
  adjustMainWindowZoom,
  attachMainWindowZoom,
  restoreMainWindowZoom,
  zoomActionForInput,
} from '../../../src/main/window/zoom';

const mocks = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
}));

function keyInput(patch: Partial<Input>): Input {
  return {
    type: 'keyDown',
    key: '=',
    code: 'Equal',
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: true,
    alt: false,
    meta: false,
    location: 0,
    modifiers: ['control'],
    ...patch,
  } as Input;
}

class FakeContents extends EventEmitter {
  zoomLevel = 0;
  destroyed = false;
  setZoomLevel = vi.fn((level: number) => {
    this.zoomLevel = level;
  });
  getZoomLevel(): number {
    return this.zoomLevel;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  asWebContents(): WebContents {
    return this as unknown as WebContents;
  }
}

describe('zoomActionForInput', () => {
  it.each([
    ['Equal', false, false, 'in'],
    ['Equal', true, false, 'in'],
    ['NumpadAdd', false, false, 'in'],
    ['Minus', false, false, 'out'],
    ['NumpadSubtract', false, false, 'out'],
    ['Digit0', false, false, 'reset'],
    ['Numpad0', false, false, 'reset'],
    ['Minus', true, false, null],
    ['Digit0', true, false, null],
    ['NumpadAdd', true, false, null],
    ['KeyA', false, false, null],
  ] as const)('maps %s shift=%s alt=%s to %s with the primary modifier', (code, shift, alt, expected) => {
    const input = keyInput({ code, shift, alt });
    expect(zoomActionForInput(input, false)).toBe(expected);
    expect(zoomActionForInput({ ...input, control: false, meta: true }, true)).toBe(expected);
  });

  it('rejects key-up, wrong modifier combinations, and missing primary modifier', () => {
    expect(zoomActionForInput(keyInput({ type: 'keyUp' }), false)).toBeNull();
    expect(zoomActionForInput(keyInput({ control: false }), false)).toBeNull();
    expect(zoomActionForInput(keyInput({ meta: true }), false)).toBeNull();
    expect(zoomActionForInput(keyInput({ control: true }), true)).toBeNull();
    expect(zoomActionForInput(keyInput({ control: true, meta: true }), true)).toBeNull();
    expect(zoomActionForInput(keyInput({ control: false, meta: true }), false)).toBeNull();
  });
});

describe('main window zoom persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-main-zoom-'));
    mocks.userData = dir;
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('steps zoomLevel by 0.5 like Electron native zoom roles, persists each step, and resets to 0', () => {
    const contents = new FakeContents();
    adjustMainWindowZoom(contents.asWebContents(), 'in');
    expect(contents.zoomLevel).toBe(0.5);
    adjustMainWindowZoom(contents.asWebContents(), 'in');
    expect(contents.zoomLevel).toBe(1);
    adjustMainWindowZoom(contents.asWebContents(), 'out');
    expect(contents.zoomLevel).toBe(0.5);
    adjustMainWindowZoom(contents.asWebContents(), 'reset');
    expect(contents.zoomLevel).toBe(0);
    expect(getMainWindowZoomLevel()).toBe(0);
  });

  it('clamps zoomLevel to [-6, 6]', () => {
    const contents = new FakeContents();
    contents.zoomLevel = 5.8;
    adjustMainWindowZoom(contents.asWebContents(), 'in');
    expect(contents.zoomLevel).toBe(6);
    expect(getMainWindowZoomLevel()).toBe(6);
    contents.zoomLevel = -5.8;
    adjustMainWindowZoom(contents.asWebContents(), 'out');
    expect(contents.zoomLevel).toBe(-6);
    expect(getMainWindowZoomLevel()).toBe(-6);
  });

  it('ignores missing or destroyed webContents', () => {
    expect(() => adjustMainWindowZoom(null, 'in')).not.toThrow();
    expect(() => adjustMainWindowZoom(undefined, 'in')).not.toThrow();
    const contents = new FakeContents();
    contents.destroyed = true;
    adjustMainWindowZoom(contents.asWebContents(), 'in');
    restoreMainWindowZoom(contents.asWebContents());
    expect(contents.setZoomLevel).not.toHaveBeenCalled();
  });

  it('restores the saved zoomLevel on dom-ready and did-finish-load reloads without redundant writes', () => {
    setMainWindowZoomLevel(1.5);
    const contents = new FakeContents();
    attachMainWindowZoom(contents.asWebContents(), () => true);
    contents.emit('dom-ready');
    expect(contents.zoomLevel).toBe(1.5);
    expect(contents.setZoomLevel).toHaveBeenCalledTimes(1);
    contents.zoomLevel = 0;
    restoreMainWindowZoom(contents.asWebContents());
    expect(contents.zoomLevel).toBe(1.5);
    expect(contents.setZoomLevel).toHaveBeenCalledTimes(2);
    restoreMainWindowZoom(contents.asWebContents());
    expect(contents.setZoomLevel).toHaveBeenCalledTimes(2);
  });

  it('handles Cmd/Ctrl +, =, -, 0 and numpad equivalents in before-input-event only while armed', () => {
    let armed = true;
    const contents = new FakeContents();
    attachMainWindowZoom(contents.asWebContents(), () => armed);
    const preventDefault = vi.fn();

    contents.emit('before-input-event', { preventDefault }, keyInput({ code: 'Equal' }));
    expect(contents.zoomLevel).toBe(0.5);
    contents.emit('before-input-event', { preventDefault }, keyInput({ code: 'NumpadAdd', key: '+', location: 3 }));
    expect(contents.zoomLevel).toBe(1);
    contents.emit('before-input-event', { preventDefault }, keyInput({ code: 'Minus', key: '-' }));
    expect(contents.zoomLevel).toBe(0.5);
    expect(getMainWindowZoomLevel()).toBe(0.5);

    armed = false;
    preventDefault.mockClear();
    contents.emit('before-input-event', { preventDefault }, keyInput({ code: 'Digit0', key: '0' }));
    expect(contents.zoomLevel).toBe(0.5);
    expect(preventDefault).not.toHaveBeenCalled();

    armed = true;
    contents.emit('before-input-event', { preventDefault }, keyInput({ code: 'Digit0', key: '0' }));
    expect(contents.zoomLevel).toBe(0);
    expect(getMainWindowZoomLevel()).toBe(0);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('debounces pinch zoom-changed saves and cancels pending saves once destroyed', () => {
    vi.useFakeTimers();
    const contents = new FakeContents();
    attachMainWindowZoom(contents.asWebContents(), () => true);
    contents.zoomLevel = 0.3;
    contents.emit('zoom-changed', { preventDefault: vi.fn() }, 'in');
    vi.advanceTimersByTime(100);
    contents.zoomLevel = 0.8;
    contents.emit('zoom-changed', { preventDefault: vi.fn() }, 'in');
    vi.advanceTimersByTime(199);
    expect(getMainWindowZoomLevel()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(getMainWindowZoomLevel()).toBe(0.8);

    contents.zoomLevel = 1.2;
    contents.emit('zoom-changed', { preventDefault: vi.fn() }, 'in');
    contents.destroyed = true;
    contents.emit('destroyed');
    vi.advanceTimersByTime(500);
    expect(getMainWindowZoomLevel()).toBe(0.8);
  });
});

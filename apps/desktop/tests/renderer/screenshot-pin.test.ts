// @vitest-environment jsdom
import { createApp, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PinnedScreenshot from '../../src/renderer/pin/PinnedScreenshot.vue';
import type { PinBridge } from '../../src/renderer/screenshot/types';

const bridge: PinBridge = { platform: 'darwin', resizeFromEdge: vi.fn(), ready: vi.fn(), failed: vi.fn(), close: vi.fn(), move: vi.fn(), resize: vi.fn() };
const setPointerCapture = vi.fn();
let app: App;
let host: HTMLDivElement;
let pin: HTMLElement;

function pointer(type: string, x: number, y: number, button = 0, pointerId = 1): void {
  const event = new MouseEvent(type, { bubbles: true, screenX: x, screenY: y, button });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  pin.dispatchEvent(event);
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.platform = 'darwin';
  window.pinBridge = bridge;
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(PinnedScreenshot);
  app.mount(host);
  pin = host.querySelector('main')!;
  pin.setPointerCapture = setPointerCapture;
});

afterEach(() => {
  app.unmount();
  host.remove();
  delete window.pinBridge;
  window.history.replaceState({}, '', '/');
});

describe('pinned screenshot interaction', () => {
  it('resizes a Windows corner without moving the image', () => {
    bridge.platform = 'win32';
    pin.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON() {} });
    pointer('pointerdown', 100, 200);
    pointer('pointermove', 120, 210);
    expect(bridge.resizeFromEdge).toHaveBeenCalledWith('top-left', 20, 10);
    expect(bridge.move).not.toHaveBeenCalled();
    pointer('pointerup', 120, 210);
  });
  it('reports whether the image loaded before the window is shown', () => {
    const image = host.querySelector('img')!;
    image.dispatchEvent(new Event('load'));
    expect(bridge.ready).toHaveBeenCalledOnce();
    image.dispatchEvent(new Event('error'));
    expect(bridge.failed).toHaveBeenCalledOnce();
  });
  it.each([['zh', '已贴图的截图'], ['en', 'Pinned screenshot']])('describes the pinned image in %s', (locale, description) => {
    app.unmount();
    window.history.replaceState({}, '', `/?locale=${locale}`);
    app = createApp(PinnedScreenshot);
    app.mount(host);
    expect(host.querySelector('img')?.alt).toBe(description);
  });
  it('closes the image on a left double click only', () => {
    pin.dispatchEvent(new MouseEvent('click'));
    pin.dispatchEvent(new MouseEvent('dblclick', { button: 2 }));
    expect(bridge.close).not.toHaveBeenCalled();
    pin.dispatchEvent(new MouseEvent('dblclick', { button: 0 }));
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it('closes with its accessible button without dragging, zooming, or handling its double click twice', () => {
    const close = host.querySelector('button')!;
    expect(close.getAttribute('aria-label')).toBe('Close');
    close.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, screenX: 100, screenY: 200 }));
    pointer('pointermove', 140, 240);
    close.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -10 }));
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(bridge.move).not.toHaveBeenCalled();
    expect(bridge.resize).not.toHaveBeenCalled();
    close.click();
    close.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it('moves with the pointer without treating click jitter or a drag as a double click', () => {
    pointer('pointerdown', 100, 200);
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    pointer('pointermove', 101, 201);
    expect(bridge.move).not.toHaveBeenCalled();
    pointer('pointermove', 110, 215, 0, 2);
    expect(bridge.move).not.toHaveBeenCalled();
    pointer('pointermove', 110, 215);
    pointer('pointermove', 125, 205);
    expect(bridge.move).toHaveBeenNthCalledWith(1, 10, 15);
    expect(bridge.move).toHaveBeenNthCalledWith(2, 15, -10);
    pointer('pointerup', 125, 205);
    pointer('pointermove', 140, 220);
    expect(bridge.move).toHaveBeenCalledTimes(2);
    pin.dispatchEvent(new MouseEvent('dblclick', { button: 0 }));
    expect(bridge.close).not.toHaveBeenCalled();
    pointer('pointerdown', 125, 205);
    pointer('pointerup', 125, 205);
    pin.dispatchEvent(new MouseEvent('dblclick', { button: 0 }));
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it.each(['pointercancel', 'lostpointercapture'])('stops moving after %s', (event) => {
    pointer('pointerdown', 100, 200);
    pointer(event, 100, 200);
    pointer('pointermove', 130, 240);
    expect(bridge.move).not.toHaveBeenCalled();
  });

  it('preserves right click and wheel zoom without starting a drag', () => {
    pointer('pointerdown', 100, 200, 2);
    pointer('pointermove', 130, 240, 2);
    expect(bridge.move).not.toHaveBeenCalled();
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    pin.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    pin.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 }));
    pin.dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }));
    expect(bridge.resize).toHaveBeenNthCalledWith(1, 0.1);
    expect(bridge.resize).toHaveBeenNthCalledWith(2, -0.1);
  });
});

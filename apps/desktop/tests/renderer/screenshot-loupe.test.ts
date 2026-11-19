// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, nextTick, ref, type App } from 'vue';
import ScreenshotLoupe from '../../src/renderer/screenshot/ScreenshotLoupe.vue';
import { LOUPE_PANEL_SIZE, LOUPE_PIXELS, LOUPE_SIZE, loupePosition, loupeScale, rgbHex, rgbaColor, sourcePixel } from '../../src/renderer/screenshot/loupe';
import type { LoupeTile } from '../../src/renderer/screenshot/loupe-pixels';
import type { ScreenshotBridge, ScreenshotOverlayContext } from '../../src/renderer/screenshot/types';

const { createLoupeTile, readLoupeTile } = vi.hoisted(() => ({
  createLoupeTile: vi.fn(),
  readLoupeTile: vi.fn(),
}));
vi.mock('../../src/renderer/screenshot/loupe-pixels', () => ({ createLoupeTile, readLoupeTile }));

const drawImage = vi.fn();
const getImageData = vi.fn();
const context2d = {
  imageSmoothingEnabled: true,
  fillStyle: '',
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  drawImage,
  getImageData,
};

let app!: App;
let host!: HTMLDivElement;
let bridge: ScreenshotBridge;
let tiles: LoupeTile[];
const context: ScreenshotOverlayContext = {
  captureId: 'capture-1', displayId: '1', locale: 'zh', frameUrl: 'shot://frame/capture-1/1.png',
  sourceSize: { width: 800, height: 600 }, displaySize: { width: 400, height: 300 },
  pointer: { x: 100, y: 100 },
  windows: [],
};

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick();
}

function mount(pointer = { x: 100, y: 100 }, locale: 'zh' | 'en' = 'zh', allowFormatToggle = true): void {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(ScreenshotLoupe, {
    context: { ...context, locale },
    frame: document.createElement('img'),
    pointer,
    allowFormatToggle,
  });
  app.mount(host);
}

function mountReactive(): { move: (x: number, y: number) => void; setCaptureId: (captureId: string) => void } {
  const pointer = ref({ x: 100, y: 100 });
  const currentContext = ref({ ...context });
  const frame = document.createElement('img');
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(defineComponent({
    components: { ScreenshotLoupe },
    setup() { return { context: currentContext, frame, pointer }; },
    template: '<ScreenshotLoupe :context="context" :frame="frame" :pointer="pointer" />',
  }));
  app.mount(host);
  return {
    move: (x, y) => { pointer.value = { x, y }; },
    setCaptureId: (captureId) => { currentContext.value = { ...currentContext.value, captureId }; },
  };
}

beforeEach(() => {
  tiles = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context2d as unknown as CanvasRenderingContext2D);
  createLoupeTile.mockReset().mockImplementation(() => {
    const tile = { canvas: { width: LOUPE_PIXELS, height: LOUPE_PIXELS }, context: {} } as unknown as LoupeTile;
    tiles.push(tile);
    return tile;
  });
  readLoupeTile.mockReset().mockReturnValue(new Uint8ClampedArray([23, 162, 184, 255]));
  drawImage.mockClear();
  getImageData.mockClear();
  bridge = {
    platform: 'darwin',
    editText: vi.fn(), loaded: vi.fn(), ready: vi.fn(), failed: vi.fn(), cancel: vi.fn(), bandStart: vi.fn(), bandEnd: vi.fn(), pointerEnter: vi.fn(),
    perform: vi.fn(), copyColor: vi.fn().mockResolvedValue(true),
    onContext: vi.fn(), onWindowCandidates: vi.fn(), onPointerLeave: vi.fn(), onClearSelection: vi.fn(), onPreviewEnabled: vi.fn(),
  };
  window.shotBridge = bridge;
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  delete window.shotBridge;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('screenshot loupe', () => {
  it('maps display points to clamped source pixels', () => {
    expect(sourcePixel({ x: 100, y: 100 }, context)).toEqual({ x: 200, y: 200 });
    expect(sourcePixel({ x: 400, y: 300 }, context)).toEqual({ x: 799, y: 599 });
  });

  it('places the panel beside the pointer and flips near screen edges', () => {
    expect(loupePosition({ x: 100, y: 100 }, context.displaySize)).toEqual({ x: 116, y: 12 });
    expect(loupePosition({ x: 390, y: 290 }, context.displaySize)).toEqual({ x: 238, y: 58 });
    expect(loupePosition({ x: 0, y: 0 }, { width: 100, height: 100 })).toEqual({ x: 16, y: 12 });
  });

  it('scales the whole panel to fit small logical screens', () => {
    expect(LOUPE_PANEL_SIZE).toEqual({ width: 136, height: 216 });
    expect(loupeScale({ width: 1280, height: 800 })).toBe(1);
    expect(loupeScale({ width: 100, height: 100 })).toBeCloseTo(76 / 216);
  });

  it('formats one sample as uppercase hex or CSS rgba', () => {
    expect(rgbHex(new Uint8ClampedArray([0, 23, 255, 0]))).toBe('#0017FF');
    expect(rgbaColor(new Uint8ClampedArray([23, 162, 184, 128]))).toBe('rgba(23,162,184,0.5)');
  });

  it('draws an unsmoothed tile and shows its coordinate and color without reading the visible canvas', async () => {
    mount();
    await flush();
    expect(createLoupeTile).toHaveBeenCalledOnce();
    expect(readLoupeTile).toHaveBeenCalledExactlyOnceWith(expect.any(HTMLImageElement), { x: 200, y: 200 }, tiles[0]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, LOUPE_PIXELS, LOUPE_PIXELS, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    expect(context2d.imageSmoothingEnabled).toBe(false);
    expect(getImageData).not.toHaveBeenCalled();
    expect(host.querySelector('.shot__loupe-coordinates')?.textContent).toBe('坐标: 200,200');
    expect(host.querySelector('.shot__loupe-value')?.textContent).toBe('HEX:#17A2B8');
    expect(host.querySelector('.shot__loupe-details')?.textContent).toContain('按 Shift 切换 RGBA/HEX');
    const panel = host.querySelector<HTMLElement>('.shot__loupe');
    expect(panel?.style.width).toBe('136px');
    expect(panel?.style.height).toBe('216px');
    expect(panel?.style.transform).toBe(`translate(116px, 12px) scale(${loupeScale(context.displaySize)})`);
  });

  it('renders concise English hints for the compact panel', async () => {
    mount(undefined, 'en');
    await flush();
    const hints = Array.from(host.querySelectorAll('.shot__loupe-hint'), (element) => element.textContent);
    expect(hints).toEqual(['Press C to copy', 'Shift for RGBA/HEX']);
  });

  it('reuses one tile across moves and releases it when the capture changes', async () => {
    const { move, setCaptureId } = mountReactive();
    await flush();
    expect(createLoupeTile).toHaveBeenCalledOnce();
    move(101, 100);
    await flush();
    move(102, 100);
    await flush();
    expect(createLoupeTile).toHaveBeenCalledOnce();
    expect(readLoupeTile).toHaveBeenCalledTimes(3);
    setCaptureId('capture-2');
    await flush();
    expect(tiles[0]!.canvas.width).toBe(1);
    expect(tiles[0]!.canvas.height).toBe(1);
    expect(createLoupeTile).toHaveBeenCalledTimes(2);
    expect(readLoupeTile).toHaveBeenCalledTimes(4);
  });

  it.each(['click', 'c', 'C'])('copies the sampled hex color with %s', async (mode) => {
    mount(undefined, 'en');
    await flush();
    if (mode === 'click') host.querySelector<HTMLButtonElement>('button[aria-label="Copy color"]')!.click();
    else window.dispatchEvent(new KeyboardEvent('keydown', { key: mode, cancelable: true }));
    await flush();
    expect(bridge.copyColor).toHaveBeenCalledExactlyOnceWith('capture-1', '#17A2B8');
    expect(host.querySelector('button[aria-label="Color copied"]')).not.toBeNull();
  });

  it('pins the panel when the pointer approaches and releases it after leaving', async () => {
    const { move } = mountReactive();
    await flush();
    expect(host.querySelector<HTMLElement>('.shot__loupe')?.style.transform).toBe(`translate(116px, 12px) scale(${loupeScale(context.displaySize)})`);
    move(100, 110);
    await flush();
    expect(host.querySelector<HTMLElement>('.shot__loupe')?.style.transform).toBe(`translate(116px, 12px) scale(${loupeScale(context.displaySize)})`);
    move(98, 110);
    await flush();
    expect(host.querySelector<HTMLElement>('.shot__loupe')?.style.transform).toBe(`translate(114px, 12px) scale(${loupeScale(context.displaySize)})`);
    move(104, 110);
    await flush();
    move(110, 110);
    await flush();
    expect(host.querySelector<HTMLElement>('.shot__loupe')?.style.transform).toBe(`translate(114px, 12px) scale(${loupeScale(context.displaySize)})`);
    move(390, 290);
    await flush();
    expect(host.querySelector<HTMLElement>('.shot__loupe')?.style.transform).toBe(`translate(238px, 58px) scale(${loupeScale(context.displaySize)})`);
  });

  it('copies with Shift+C without also switching the format on keyup', async () => {
    mount(undefined, 'en');
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', shiftKey: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    await flush();
    expect(bridge.copyColor).toHaveBeenCalledExactlyOnceWith('capture-1', '#17A2B8');
    expect(host.querySelector('.shot__loupe-value')?.textContent).toBe('HEX:#17A2B8');
  });

  it('switches between hex and rgba only after Shift is released and copies the visible format', async () => {
    mount(undefined, 'en');
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    await flush();
    expect(host.querySelector('.shot__loupe-value')?.textContent).toBe('HEX:#17A2B8');
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    await flush();
    expect(host.querySelector('.shot__loupe-value')?.textContent).toBe('RGBA:23,162,184,1');
    host.querySelector<HTMLButtonElement>('button[aria-label="Copy color"]')!.click();
    await flush();
    expect(bridge.copyColor).toHaveBeenLastCalledWith('capture-1', 'rgba(23,162,184,1)');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    await flush();
    expect(host.querySelector('.shot__loupe-value')?.textContent).toBe('HEX:#17A2B8');
  });

  it('does not switch formats while selection modifiers own Shift', async () => {
    mount(undefined, 'en', false);
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    await flush();
    expect(host.querySelector('.shot__loupe-value')?.textContent).toBe('HEX:#17A2B8');
  });

  it('does not report a stale copy after the visible format changes', async () => {
    let finish!: (copied: boolean) => void;
    bridge.copyColor = vi.fn().mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    mount(undefined, 'en');
    await flush();
    host.querySelector<HTMLButtonElement>('button[aria-label="Copy color"]')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    await flush();
    finish(true);
    await flush();
    expect(bridge.copyColor).toHaveBeenCalledExactlyOnceWith('capture-1', '#17A2B8');
    expect(host.querySelector('button[aria-label="Color copied"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Copy color"]')).not.toBeNull();
  });

  it('does not copy with editing modifiers or while composing', async () => {
    mount();
    await flush();
    for (const event of [
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }),
      new KeyboardEvent('keydown', { key: 'c', metaKey: true }),
      new KeyboardEvent('keydown', { key: 'c', altKey: true }),
      new KeyboardEvent('keydown', { key: 'c', isComposing: true }),
    ]) window.dispatchEvent(event);
    await flush();
    expect(bridge.copyColor).not.toHaveBeenCalled();
  });
});

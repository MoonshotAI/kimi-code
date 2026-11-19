// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolMedia } from '@moonshot-ai/app-core/client';

type Bounds = { x: number; y: number; w: number; innerRect?: { x: number; y: number; w: number; h: number } };

const swipe = vi.hoisted(() => ({ instances: [] as Array<{
  options: { dataSource: Array<Record<string, unknown>>; index: number };
  refreshed: number[];
  filters: Map<string, (value: unknown, itemData: unknown, index: number) => unknown>;
  emit: (name: string) => void;
}> }));

vi.mock('photoswipe', () => {
  class FakeSwipe {
    options: { dataSource: Array<Record<string, unknown>>; index: number };
    currIndex: number;
    refreshed: number[] = [];
    filters = new Map<string, (value: unknown, itemData: unknown, index: number) => unknown>();
    mainScroll = { itemHolders: [] };
    element = document.createElement('div');
    private handlers = new Map<string, Array<() => void>>();

    constructor(options: { dataSource: Array<Record<string, unknown>>; index: number }) {
      this.options = options;
      this.currIndex = options.index;
      swipe.instances.push(this);
    }

    on(name: string, handler: () => void): void {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    }

    emit(name: string): void {
      for (const handler of this.handlers.get(name) ?? []) handler();
    }

    addFilter(name: string, filter: (value: unknown, itemData: unknown, index: number) => unknown): void {
      this.filters.set(name, filter);
    }

    getItemData(index: number): Record<string, unknown> | undefined {
      return this.options.dataSource[index];
    }

    refreshSlideContent(index: number): void {
      this.refreshed.push(index);
    }

    init(): void {
      this.emit('afterInit');
      this.emit('openingAnimationStart');
    }

    close(): void {
      this.emit('destroy');
    }
  }
  return { default: FakeSwipe };
});

import { openImagePreview } from '../src/lib/mediaPreview';

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;

  set src(value: string) {
    if (value === '') return;
    queueMicrotask(() => {
      this.naturalWidth = 960;
      this.naturalHeight = 600;
      this.onload?.();
    });
  }
}

const objectUrlDescriptors = (['createObjectURL', 'revokeObjectURL'] as const).map((name) => [name, Object.getOwnPropertyDescriptor(URL, name)] as const);

beforeEach(() => {
  swipe.instances.length = 0;
  vi.stubGlobal('Image', FakeImage);
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:full'), revokeObjectURL: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, descriptor] of objectUrlDescriptors) {
    if (descriptor) Object.defineProperty(URL, name, descriptor);
    else Reflect.deleteProperty(URL, name);
  }
});

function thumbnail(src: string): HTMLImageElement {
  return { currentSrc: src, naturalWidth: 960, naturalHeight: 600, isConnected: true } as unknown as HTMLImageElement;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) await Promise.resolve();
}

it('does not rebuild the opening picture during the zoom or when it is already shown', async () => {
  const src = 'data:image/jpeg;base64,AAAA';
  const api = { getFileBlob: vi.fn(), getSessionMediaBlob: vi.fn() };
  const media: ToolMedia = { kind: 'image', url: src, mimeType: 'image/jpeg' };
  const handle = openImagePreview({ api, images: [media], index: 0, thumbImg: thumbnail(src), onClose: () => {} });
  await vi.waitFor(() => expect(swipe.instances).toHaveLength(1));
  const pswp = swipe.instances[0]!;
  await settle();
  expect(pswp.refreshed).toEqual([]);
  pswp.emit('openingAnimationEnd');
  await settle();
  expect(pswp.refreshed).toEqual([]);
  handle.close();
});

it('swaps in the full picture only after the opening zoom has finished', async () => {
  const api = { getFileBlob: vi.fn(), getSessionMediaBlob: vi.fn(async () => new Blob(['image'])) };
  const media: ToolMedia = { kind: 'image', url: 'https://media.example/shot.png', fileId: 'file-1', sessionId: 'session-1' };
  const handle = openImagePreview({ api, images: [media], index: 0, thumbImg: thumbnail('blob:thumbnail'), onClose: () => {} });
  await vi.waitFor(() => expect(swipe.instances).toHaveLength(1));
  const pswp = swipe.instances[0]!;
  await settle();
  expect(api.getSessionMediaBlob).not.toHaveBeenCalled();
  expect(pswp.refreshed).toEqual([]);
  pswp.emit('openingAnimationEnd');
  await vi.waitFor(() => expect(pswp.refreshed).toEqual([0]));
  expect(pswp.options.dataSource[0]).toMatchObject({ src: 'blob:full', w: 960, h: 600 });
  handle.close();
});

it('zooms out of and back into the part of a clipped thumbnail that is on screen', async () => {
  const src = 'data:image/jpeg;base64,AAAA';
  const button = document.createElement('button');
  const canvas = document.createElement('span');
  const img = document.createElement('img');
  canvas.append(img);
  button.append(canvas);
  document.body.append(button);
  const rects = new Map<Element, { x: number; y: number; width: number; height: number }>([
    [img, { x: 884, y: 296, width: 60, height: 36 }],
    [canvas, { x: 884, y: 296, width: 60, height: 36 }],
    [button, { x: 904, y: 301, width: 32, height: 20 }],
    [document.body, { x: 0, y: 0, width: 1400, height: 1000 }],
  ]);
  for (const element of rects.keys()) element.getBoundingClientRect = () => DOMRect.fromRect(rects.get(element));
  const clipping = new Set<Element>([button]);
  vi.stubGlobal('getComputedStyle', (element: Element) => {
    const overflow = clipping.has(element) ? 'hidden' : 'visible';
    return { overflowX: overflow, overflowY: overflow, getPropertyValue: () => '' };
  });
  Object.defineProperties(img, { currentSrc: { value: src }, naturalWidth: { value: 960 }, naturalHeight: { value: 600 } });
  const api = { getFileBlob: vi.fn(), getSessionMediaBlob: vi.fn() };
  const handle = openImagePreview({ api, images: [{ kind: 'image', url: src, mimeType: 'image/jpeg' }], index: 0, thumbImg: img, onClose: () => {} });
  await vi.waitFor(() => expect(swipe.instances).toHaveLength(1));
  const pswp = swipe.instances[0]!;
  const bounds = (value: Bounds | undefined) => pswp.filters.get('thumbBounds')?.(value, pswp.options.dataSource[0], 0);
  const whole: Bounds = { x: 884, y: 296, w: 60, innerRect: { x: 0, y: 0, w: 60, h: 36 } };
  expect(bounds(whole)).toEqual({ x: 884, y: 296, w: 60, innerRect: { x: -20, y: -5, w: 32, h: 20 } });
  clipping.clear();
  expect(bounds(whole)).toEqual(whole);
  rects.set(img, { x: 884, y: -30, width: 60, height: 36 });
  rects.set(canvas, { x: 884, y: -30, width: 60, height: 36 });
  expect(bounds({ x: 884, y: -30, w: 60, innerRect: { x: 0, y: 0, w: 60, h: 36 } }))
    .toEqual({ x: 884, y: -30, w: 60, innerRect: { x: 0, y: -30, w: 60, h: 6 } });
  rects.set(img, { x: 884, y: -40, width: 60, height: 36 });
  rects.set(canvas, { x: 884, y: -40, width: 60, height: 36 });
  expect(bounds({ x: 884, y: -40, w: 60, innerRect: { x: 0, y: 0, w: 60, h: 36 } })).toBeUndefined();
  rects.set(img, { x: 884, y: 296, width: 60, height: 36 });
  rects.set(canvas, { x: 884, y: 296, width: 60, height: 36 });
  clipping.add(document.body);
  rects.set(document.body, { x: 0, y: 0, width: 800, height: 200 });
  expect(bounds(whole)).toBeUndefined();
  expect(bounds(undefined)).toBeUndefined();
  handle.close();
  button.remove();
});

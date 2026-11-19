import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dimsFromMedia, openImagePreview, previewPadding } from '../src/lib/mediaPreview';
import type { ToolMedia } from '@moonshot-ai/app-core/client';

const readFrom =
  (tokens: Record<string, string>) =>
  (name: string): string =>
    tokens[name] ?? '';

describe('previewPadding', () => {
  it('clears native window controls without changing the other edges', () => {
    expect(previewPadding(readFrom({ '--media-preview-top-inset': '40px' }))).toEqual({
      top: 96, bottom: 56, left: 24, right: 24,
    });
    expect(previewPadding(readFrom({ '--media-preview-top-inset': '32px' })).top).toBe(88);
  });

  it.each(['0px', '-40px', 'invalid'])('ignores an unusable native inset: %s', (inset) => {
    expect(previewPadding(readFrom({ '--media-preview-top-inset': inset })).top).toBe(56);
  });

  it('derives the inset from the spacing tokens', () => {
    expect(previewPadding(readFrom({ '--space-6': '24px', '--space-8': '32px' }))).toEqual({
      top: 56,
      bottom: 56,
      left: 24,
      right: 24,
    });
  });

  it('follows token changes instead of freezing literals', () => {
    expect(previewPadding(readFrom({ '--space-6': '16px', '--space-8': '40px' }))).toEqual({
      top: 56,
      bottom: 56,
      left: 16,
      right: 16,
    });
  });

  it('falls back to the token scale values when tokens are missing or malformed', () => {
    expect(previewPadding(readFrom({}))).toEqual({ top: 56, bottom: 56, left: 24, right: 24 });
    expect(previewPadding(readFrom({ '--space-6': 'abc', '--space-8': '-4px' }))).toEqual({
      top: 56,
      bottom: 56,
      left: 24,
      right: 24,
    });
  });
});

describe('dimsFromMedia', () => {
  it('parses well-formed dimensions', () => {
    expect(dimsFromMedia({ kind: 'image', url: 'u', dimensions: '800x600' })).toEqual({ w: 800, h: 600 });
  });

  it('rejects missing, malformed, zero and absurd dimensions', () => {
    expect(dimsFromMedia({ kind: 'image', url: 'u' })).toBeNull();
    expect(dimsFromMedia({ kind: 'image', url: 'u', dimensions: 'abc' })).toBeNull();
    expect(dimsFromMedia({ kind: 'image', url: 'u', dimensions: '0x10' })).toBeNull();
    expect(dimsFromMedia({ kind: 'image', url: 'u', dimensions: '999999999999x10' })).toBeNull();
  });
});

interface FakePswp {
  currIndex: number;
  refreshes: number[];
  emit(evt: string): void;
  getItemData(i: number): Record<string, unknown>;
}

const hoisted = vi.hoisted(() => ({
  instances: [] as unknown[],
  pendingBlobs: [] as Array<() => void>,
  revoked: [] as string[],
  created: [] as string[],
}));

vi.mock('photoswipe', () => {
  class FakePhotoSwipe {
    options: { dataSource: Array<Record<string, unknown>>; index?: number };
    handlers = new Map<string, Array<() => void>>();
    mainScroll = { itemHolders: [{ slide: null }, { slide: null }, { slide: null }] };
    refreshes: number[] = [];
    currIndex: number;
    ui: unknown;
    element: unknown;
    constructor(options: { dataSource: Array<Record<string, unknown>>; index?: number }) {
      this.options = options;
      this.currIndex = options.index ?? 0;
      hoisted.instances.push(this);
    }
    addFilter(): void {}
    on(evt: string, cb: () => void): void {
      const list = this.handlers.get(evt) ?? [];
      list.push(cb);
      this.handlers.set(evt, list);
    }
    emit(evt: string): void {
      for (const cb of this.handlers.get(evt) ?? []) cb();
    }
    getItemData(i: number): Record<string, unknown> {
      return this.options.dataSource[i]!;
    }
    refreshSlideContent(i: number): void {
      this.refreshes.push(i);
    }
    init(): void {
      this.emit('uiRegister');
      this.emit('change');
      this.emit('afterInit');
    }
    close(): void {
      this.emit('closingAnimationStart');
      this.emit('destroy');
    }
  }
  return { default: FakePhotoSwipe };
});

const api = {
  getFileBlob: (fileId: string) =>
    new Promise<Blob>((resolve) => {
      hoisted.pendingBlobs.push(() => resolve(new Blob([fileId])));
    }),
  getSessionMediaBlob: (sessionId: string, fileId: string) =>
    new Promise<Blob>((resolve) => {
      hoisted.pendingBlobs.push(() => resolve(new Blob([sessionId, fileId])));
    }),
};

const realCreateObjectURL = URL.createObjectURL.bind(URL);
const realRevokeObjectURL = URL.revokeObjectURL.bind(URL);

beforeEach(() => {
  hoisted.instances.length = 0;
  hoisted.pendingBlobs.length = 0;
  hoisted.revoked.length = 0;
  hoisted.created.length = 0;
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  URL.createObjectURL = (() => {
    const url = `blob:mock-${hoisted.created.length}`;
    hoisted.created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    hoisted.revoked.push(url);
  }) as typeof URL.revokeObjectURL;
});

afterEach(() => {
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  vi.unstubAllGlobals();
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const flushBlobs = (): void => {
  while (hoisted.pendingBlobs.length > 0) hoisted.pendingBlobs.shift()!();
};
const pswp = (): FakePswp => hoisted.instances[0] as FakePswp;

const media = (i: number, dimensions = '640x480'): ToolMedia => ({
  kind: 'image',
  url: `app://media/${i}`,
  fileId: `f${i}`,
  dimensions,
});

const thumb = (src: string, w = 640, h = 480): HTMLImageElement =>
  ({ currentSrc: src, naturalWidth: w, naturalHeight: h }) as HTMLImageElement;

describe('openImagePreview slide lifecycle', () => {
  it('resets slide data when a resolved slide is pruned, so revisiting never touches the revoked URL', async () => {
    const images = Array.from({ length: 6 }, (_, i) => media(i));
    openImagePreview({ api, images, index: 0, thumbImg: null, onClose: () => {} });
    flushBlobs();
    await flush();
    const p = pswp();
    flushBlobs();
    await flush();
    const urlBeforePrune = p.getItemData(0).src as string;
    p.currIndex = 3;
    p.emit('change');
    expect(hoisted.revoked).toEqual([urlBeforePrune]);
    expect(p.getItemData(0).src).toBeUndefined();
    expect(p.getItemData(0).w).toBe(640);
    flushBlobs();
    await flush();
    p.currIndex = 0;
    p.emit('change');
    flushBlobs();
    await flush();
    const reResolved = p.getItemData(0).src as string;
    expect(reResolved.startsWith('blob:mock-')).toBe(true);
    expect(reResolved).not.toBe(urlBeforePrune);
    expect(p.refreshes).toEqual([]);
    p.emit('openingAnimationEnd');
    expect(p.refreshes).toEqual([3, 0]);
  });

  it('never refreshes a slide while the preview is closing', async () => {
    const images = Array.from({ length: 3 }, (_, i) => media(i));
    openImagePreview({ api, images, index: 0, thumbImg: thumb('thumb://0'), onClose: () => {} });
    await flush();
    const p = pswp();
    p.emit('openingAnimationEnd');
    p.currIndex = 1;
    p.emit('change');
    p.emit('closingAnimationStart');
    flushBlobs();
    await flush();
    expect(p.refreshes).toEqual([]);
  });

  it('never exposes protected media URLs after authorized image loads fail', async () => {
    const requested: string[] = [];
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      naturalHeight = 0;
      set src(value: string) {
        requested.push(value);
        queueMicrotask(() => this.onerror?.());
      }
    });
    const failingApi = {
      getFileBlob: vi.fn(async () => { throw new Error('media temporarily unavailable'); }),
      getSessionMediaBlob: vi.fn(),
    };
    const images = Array.from({ length: 3 }, (_, i) => media(i));

    openImagePreview({ api: failingApi, images, index: 0, thumbImg: null, onClose: () => {} });
    await flush();

    expect(requested).toEqual([]);
    for (let i = 0; i < images.length; i++) {
      expect(pswp().getItemData(i).src).toBeUndefined();
    }
  });
});

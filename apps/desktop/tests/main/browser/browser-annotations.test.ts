import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Script } from 'node:vm';
import type { WebContents } from 'electron';
import { browserAnnotationCrop } from '../../../src/shared/browser-annotation';
import { browserAnnotationCommandScript, browserAnnotationContextTargetScript, browserAnnotationContextTrackingScript, browserAnnotationPickerScript, browserAnnotationScreenshotScript } from '../../../src/main/browser/browser-annotation-script';

const markerEvents = new WeakMap<object, Map<string, () => void>>();
function markerEnvironment<T extends object>(context: T): T {
  if (markerEvents.has(context) || 'window' in context) return context;
  const events = new Map<string, () => void>();
  markerEvents.set(context, events);
  const listeners = { addEventListener: (name: string, callback: () => void) => events.set(name, callback), removeEventListener: (name: string) => events.delete(name) };
  Object.assign((context as { document?: object }).document ?? {}, listeners);
  return Object.assign(context, {
    window: { ...listeners, scrollTo() {} },
    Element: class {},
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  });
}

const pickStyle = { borderColor: '#1783ff', ancestorColor: '#bc4c00', fillColor: 'rgba(23, 131, 255, 0.25)', borderRadius: '4px', transitionDuration: '120ms', transitionTiming: 'ease-out', labelColor: 'white', labelFont: 'monospace', labelFontSize: '12px', labelPadding: '2px 4px', labelGap: '4px', labelMaxWidth: '360px', regionLabel: 'Region' };

interface FakeImage {
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
  toDataURL(): string;
  crop(rect: { width: number; height: number }): FakeImage;
  resize(rect: { width: number; height: number }): FakeImage;
}

const runtime = vi.hoisted(() => ({ directory: '', page: null as null | { webContents: WebContents; generation: number; visible: boolean; bounds: { x: number; y: number; width: number; height: number }; inputScale: number } }));
const image = vi.hoisted(() => {
  const create = (width: number, height: number): FakeImage => ({
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.from('owned screenshot bytes'),
    toDataURL: () => 'data:image/png;base64,AA==',
    crop: (rect: { width: number; height: number }) => create(rect.width, rect.height),
    resize: (rect: { width: number; height: number }) => create(rect.width, rect.height),
  });
  return create(1600, 1200);
});

vi.mock('electron', () => ({ app: { getPath: () => runtime.directory }, nativeImage: { createFromBuffer: () => image } }));
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { warn: vi.fn() } }));
vi.mock('../../../src/main/browser/browser-view', () => ({ getBrowserPage: () => runtime.page }));
const mouseTouch = vi.hoisted(() => {
  const restore = vi.fn(async () => {});
  return { restore, suspend: vi.fn(async () => restore) };
});
vi.mock('../../../src/main/browser/browser-debugger', () => ({ suspendBrowserMouseTouch: mouseTouch.suspend }));

import { attachBrowserAnnotationWindow, resetBrowserAnnotationCaptures, completeBrowserAnnotationCapture, BrowserAnnotationAssetStore, cancelBrowserAnnotationPick, isBrowserAnnotationPicking, pickBrowserAnnotation, readBrowserAnnotationAsset, showBrowserAnnotation } from '../../../src/main/browser/browser-annotations';

class Contents extends EventEmitter {
  focus = vi.fn();
  capturePage = vi.fn(async () => image);
  getZoomFactor = () => 1.25;
  isDestroyed = () => false;
  pending = false;
  executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, scripts: { code: string }[]) => {
    const code = scripts[0]!.code;
    if (!code.includes('const id =')) return true;
    if (this.pending) return new Promise(() => {});
    const id = JSON.parse(/const id = ("[^"]+");/.exec(code)![1]!);
    return {
      version: 1, id, ordinal: 1, label: 'Element', capturedAt: '2026-09-07T00:00:00.000Z',
      page: { url: 'https://example.test', title: 'Example' },
      target: { kind: 'element', tagName: 'button', text: 'Save', bounds: { x: 10, y: 10, width: 100, height: 30 } },
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 2 },
    };
  });
}

beforeEach(async () => {
  runtime.directory = await mkdtemp(join(tmpdir(), 'browser-annotation-test-'));
  runtime.page = null;
  mouseTouch.suspend.mockClear();
  mouseTouch.restore.mockClear();
});
afterEach(async () => {
  cancelBrowserAnnotationPick('page');
  await resetBrowserAnnotationCaptures();
  runtime.page = null;
  await rm(runtime.directory, { recursive: true, force: true });
});

function page(contents: Contents) {
  runtime.page = { webContents: contents as unknown as WebContents, generation: 1, visible: true, bounds: { x: 100, y: 100, width: 800, height: 600 }, inputScale: 1 };
}

describe('browser annotation captures', () => {
  it('keeps existing and newly drawn markers hidden until overlapping screenshots finish', () => {
    const marker = { style: { visibility: '' }, remove() {} };
    const target = { marker, element: { isConnected: true, getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 30 }) } };
    const context = {
      __kimiBrowserAnnotations: { targets: new Map([['capture', target]]) }, scrollX: 0, scrollY: 0,
      requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn(),
      document: { createElement: () => ({ style: {}, dataset: {}, append() {}, remove() {} }), documentElement: { append() {} } },
    };
    const run = (code: string) => new Script(code).runInNewContext(markerEnvironment(context));
    run(browserAnnotationScreenshotScript('first', true));
    run(browserAnnotationScreenshotScript('second', true));
    expect(marker.style.visibility).toBe('hidden');
    run(browserAnnotationCommandScript('mark', 'capture', 1, '#1783ff'));
    expect(target.marker.style.visibility).toBe('hidden');
    run(browserAnnotationScreenshotScript('first', false));
    expect(target.marker.style.visibility).toBe('hidden');
    run(browserAnnotationScreenshotScript('second', false));
    expect(target.marker.style.visibility).toBe('');
  });

  it('tracks saved element bounds through scrolling and layout changes and stops after removal', () => {
    let bounds = { x: 10, y: 40, width: 100, height: 30 };
    let frame: (() => void) | undefined;
    const marker = { style: {} as Record<string, string>, dataset: {}, append() {}, remove: vi.fn() };
    const element = { isConnected: true, getBoundingClientRect: () => bounds };
    const target = { element, marker: null as typeof marker | null };
    const context = {
      __kimiBrowserAnnotations: { targets: new Map([['capture', target]]) }, scrollX: 0, scrollY: 0,
      requestAnimationFrame: (callback: () => void) => { frame = callback; return 1; },
      cancelAnimationFrame: () => { frame = undefined; },
      document: { createElement: () => marker, documentElement: { append() {} } },
    };
    const run = (code: string) => new Script(code).runInNewContext(markerEnvironment(context));
    run(browserAnnotationCommandScript('mark', 'capture', 1, '#1783ff'));
    expect(marker.style['top']).toBe('40px');
    expect(frame).toBeUndefined();
    context.scrollY = 300;
    markerEvents.get(context)!.get('scroll')!();
    const scrolling = frame; frame = undefined; scrolling?.();
    expect(frame).toBeUndefined();
    expect(Number.parseFloat(marker.style['top']!) - context.scrollY).toBe(40);
    bounds = { x: 20, y: 10, width: 120, height: 50 };
    markerEvents.get(context)!.get('resize')!();
    const resizing = frame as (() => void) | undefined; frame = undefined; resizing?.();
    expect(marker.style).toMatchObject({ left: '20px', top: '310px', width: '120px', height: '50px' });
    element.isConnected = false;
    markerEvents.get(context)!.get('resize')!();
    const pending = frame as (() => void) | undefined;
    frame = undefined;
    pending?.();
    expect(marker.remove).toHaveBeenCalled();
    expect(target.marker).toBeNull();
    expect(frame).toBeUndefined();
  });

  it('stops tracking explicitly hidden markers and leaves regions at their captured document coordinates', () => {
    let frame: (() => void) | undefined;
    const markers: Array<{ style: Record<string, string>; dataset: {}; remove: () => void }> = [];
    const region = { element: null, target: { bounds: { x: 10, y: 20, width: 30, height: 40 } }, scrollX: 0, scrollY: 300, marker: null };
    const element = { element: { isConnected: true, getBoundingClientRect: () => ({ x: 5, y: 5, width: 10, height: 10 }) }, marker: null };
    const context = {
      __kimiBrowserAnnotations: { targets: new Map<string, unknown>([['region', region], ['element', element]]) }, scrollX: 0, scrollY: 500,
      requestAnimationFrame: (callback: () => void) => { frame = callback; return 1; }, cancelAnimationFrame: () => { frame = undefined; },
      document: { createElement: () => { const marker = { style: {}, dataset: {}, append() {}, remove() {} }; markers.push(marker); return marker; }, documentElement: { append() {} } },
    };
    const run = (code: string) => new Script(code).runInNewContext(markerEnvironment(context));
    run(browserAnnotationCommandScript('mark', 'region'));
    expect(markers[0]?.style['top']).toBe('320px');
    expect(frame).toBeUndefined();
    run(browserAnnotationCommandScript('mark', 'element'));
    expect(frame).toBeUndefined();
    markerEvents.get(context)!.get('scroll')!();
    expect(frame).toBeDefined();
    run(browserAnnotationCommandScript('unmark', 'element'));
    expect(frame).toBeUndefined();
    expect(markers[0]?.style['top']).toBe('320px');
  });

  it.each(['success', 'failure', 'cancel'] as const)('restores markers after screenshot %s', async (outcome) => {
    const contents = new Contents();
    page(contents);
    const marker = { style: { visibility: '' } };
    const context = { __kimiBrowserAnnotations: { targets: new Map([['old', { marker }]]) }, innerWidth: 800, innerHeight: 600, document: { createElement: () => ({ style: {}, setAttribute() {}, append() {}, remove() {} }), documentElement: { append() {} } } };
    const execute = contents.executeJavaScriptInIsolatedWorld.getMockImplementation()!;
    contents.executeJavaScriptInIsolatedWorld.mockImplementation(async (world, scripts) => {
      if (scripts[0]!.code.includes('const masks =')) new Script(scripts[0]!.code).runInNewContext(markerEnvironment(context));
      return execute(world, scripts);
    });
    contents.capturePage.mockImplementation(async () => {
      expect(marker.style.visibility).toBe('hidden');
      if (outcome === 'failure') throw new Error('Screenshot failed');
      if (outcome === 'cancel') cancelBrowserAnnotationPick('page');
      return image;
    });
    const capture = pickBrowserAnnotation('page', pickStyle);
    if (outcome === 'failure') await expect(capture).rejects.toThrow('Screenshot failed');
    else if (outcome === 'cancel') expect(await capture).toBeNull();
    else expect(await capture).not.toBeNull();
    expect(marker.style.visibility).toBe('');
    expect(isBrowserAnnotationPicking('page')).toBe(false);
  });

  it('animates hover bounds with the supplied appearance and tracks a dragged region immediately', async () => {
    class ElementStub {
      style: Record<string, string> = {};
      dataset: Record<string, string> = {};
      children: ElementStub[] = [];
      listeners = new Map<string, (event: Record<string, unknown>) => void>();
      isConnected = true;
      innerText = 'Frozen target';
      getAttribute(_name: string) { return null; }
      getRootNode(): object { return context.document; }
      tagName = 'BUTTON';
      localName = 'button';
      attributes: { name: string; value: string }[] = [];
      id = 'save';
      classList = ['primary', 'wide'];
      parentElement: ElementStub | null = null;
      textContent = '';
      title = '';
      get offsetWidth() { return Math.min(100, parseFloat(this.style['maxWidth'] ?? '100')); }
      offsetHeight = 20;
      append(...children: ElementStub[]) { this.children.push(...children); }
      remove() {}
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) { this.listeners.set(type, listener); }
      setPointerCapture() {}
      getBoundingClientRect() { return { x: 10, y: 20, width: 100, height: 30 }; }
    }
    const root = new ElementStub();
    const button = new ElementStub();
    const documentListeners = new Map<string, (event?: { isTrusted: boolean; composedPath(): unknown[] }) => void>();
    const windowListeners = new Map<string, () => void>();
    const frames: (() => void)[] = [];
    const ancestryTimers = new Map<number, () => void>();
    let ancestryTimerId = 0;
    let underPointer = button;
    const context = {
      document: { title: 'Example', querySelectorAll: () => [button], documentElement: root, body: new ElementStub(), createElement: () => new ElementStub(), elementFromPoint: () => underPointer, addEventListener(type: string, listener: () => void) { documentListeners.set(type, listener); }, removeEventListener(type: string) { documentListeners.delete(type); } },
      window: { addEventListener(type: string, listener: () => void) { windowListeners.set(type, listener); }, removeEventListener(type: string) { windowListeners.delete(type); } },
      requestAnimationFrame(callback: () => void) { frames.push(callback); return frames.length; },
      cancelAnimationFrame: vi.fn(),
      setTimeout(callback: () => void) { ancestryTimers.set(++ancestryTimerId, callback); return ancestryTimerId; },
      clearTimeout(id: number) { ancestryTimers.delete(id); },
      CSS: { escape: (value: string) => value }, location: { href: 'https://example.test' }, HTMLInputElement: class {}, HTMLTextAreaElement: class {},
      Element: ElementStub, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
      __kimiBrowserAnnotations: { targets: new Map(), cancel: null as null | (() => void), contextElement: null as ElementStub | null, contextTarget: null as { id: string; element: ElementStub } | null },
    };
    const result = new Script(browserAnnotationPickerScript('capture', pickStyle)).runInNewContext(context) as Promise<unknown>;
    const glass = root.children[0]!;
    const highlight = glass.children[0]!;
    glass.listeners.get('pointermove')!({ clientX: 20, clientY: 25 });
    expect(highlight.style).toMatchObject({ borderColor: pickStyle.borderColor, backgroundColor: pickStyle.fillColor, borderRadius: '4px', transitionDuration: '120ms', transitionProperty: 'left, top, width, height', left: '10px', top: '20px' });
    const badge = glass.children[1]!;
    expect(badge.textContent).toBe('button#save.primary.wide');
    expect(badge.style).toMatchObject({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '360px', left: '10px' });
    expect(badge.style['top']).toBe('54px');
    context.innerHeight = 50;
    glass.listeners.get('pointermove')!({ clientX: 20, clientY: 25 });
    expect(badge.style['display']).toBe('none');
    context.innerHeight = 600;
    context.innerWidth = 80;
    button.id = '<img onerror=bad>'.repeat(200);
    glass.listeners.get('pointermove')!({ clientX: 20, clientY: 25 });
    expect(badge.textContent.length).toBe(2048);
    expect(badge.style).toMatchObject({ maxWidth: '72px', left: '4px' });
    const next = new ElementStub();
    next.id = 'after-scroll';
    next.getBoundingClientRect = () => ({ x: 10, y: 90, width: 50, height: 30 });
    underPointer = next;
    documentListeners.get('scroll')!();
    documentListeners.get('scroll')!();
    windowListeners.get('resize')!();
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(badge.textContent).toBe('button#after-scroll.primary.wide');
    expect(badge.style).toMatchObject({ top: '66px', transitionProperty: 'none' });
    expect(highlight.style).toMatchObject({ top: '90px', width: '50px' });

    const parent = new ElementStub();
    parent.id = 'parent';
    parent.getBoundingClientRect = () => ({ x: 0, y: 0, width: 300, height: 180 });
    next.parentElement = parent;
    const grandparent = new ElementStub();
    grandparent.id = 'grandparent';
    grandparent.getBoundingClientRect = () => ({ x: 0, y: 0, width: 600, height: 300 });
    parent.parentElement = grandparent;
    const wheel = { clientX: 20, clientY: 25, deltaY: -48, deltaMode: 0, isTrusted: true, preventDefault() {}, stopImmediatePropagation() {} };
    glass.listeners.get('wheel')!(wheel);
    expect(highlight.style).toMatchObject({ width: '50px', borderStyle: 'dashed' });
    expect(glass.children[2]!.style).toMatchObject({ width: '300px', display: 'block', borderColor: pickStyle.ancestorColor });
    glass.listeners.get('wheel')!(wheel);
    expect(glass.children[2]!.style['width']).toBe('600px');
    [...ancestryTimers.values()].at(-1)!();
    expect(highlight.style).toMatchObject({ width: '600px', borderStyle: 'solid' });
    expect(glass.children[2]!.style['display']).toBe('none');
    expect(badge.textContent).toContain('#grandparent');

    glass.listeners.get('pointerdown')!({ clientX: 20, clientY: 25, button: 0, isTrusted: true, pointerId: 1, preventDefault() {}, stopImmediatePropagation() {} });
    glass.listeners.get('pointermove')!({ clientX: 70, clientY: 65 });
    expect(highlight.style).toMatchObject({ transitionProperty: 'none', width: '50px', height: '40px' });
    expect(badge.textContent).toBe('Region');
    context.__kimiBrowserAnnotations.cancel?.();
    expect(await result).toBeNull();
    expect(documentListeners.has('scroll')).toBe(false);
    expect(windowListeners.has('resize')).toBe(false);
    new Script(browserAnnotationContextTrackingScript()).runInNewContext(markerEnvironment(context));
    documentListeners.get('contextmenu')!({ isTrusted: false, composedPath: () => [button] });
    expect(new Script(browserAnnotationContextTargetScript('context-token')).runInNewContext(markerEnvironment(context))).toBe(false);
    button.id = 'right-clicked';
    documentListeners.get('contextmenu')!({ isTrusted: true, composedPath: () => [button] });
    expect(new Script(browserAnnotationContextTargetScript('context-token')).runInNewContext(markerEnvironment(context))).toBe(true);
    underPointer = next;
    const captured = await new Script(browserAnnotationPickerScript('context-capture', { ...pickStyle, contextTargetId: 'context-token' })).runInNewContext(markerEnvironment(context));
    expect(captured).toMatchObject({ target: { tagName: 'button', text: 'Frozen target', locator: { selector: '#right-clicked' } } });
    expect(context.__kimiBrowserAnnotations.targets.get('context-capture').element).toBe(button);
    expect(await new Script(browserAnnotationPickerScript('reused', { ...pickStyle, contextTargetId: 'context-token' })).runInNewContext(markerEnvironment(context))).toBeNull();
    documentListeners.get('contextmenu')!({ isTrusted: true, composedPath: () => [button] });
    new Script(browserAnnotationContextTargetScript('stale-token')).runInNewContext(markerEnvironment(context));
    button.isConnected = false;
    expect(await new Script(browserAnnotationPickerScript('stale', { ...pickStyle, contextTargetId: 'stale-token' })).runInNewContext(markerEnvironment(context))).toBeNull();

  });

  it('clips CSS bounds to the viewport and maps them into screenshot pixels', () => {
    expect(browserAnnotationCrop({ x: -10, y: 590, width: 50, height: 30 }, { width: 800, height: 600 }, { width: 1600, height: 1200 })).toEqual({
      crop: { x: 0, y: 590, width: 40, height: 10 }, pixels: { x: 0, y: 1180, width: 80, height: 20 },
    });
    expect(browserAnnotationCrop({ x: 900, y: 0, width: 50, height: 30 }, { width: 800, height: 600 }, { width: 1600, height: 1200 })).toBeNull();
    expect(browserAnnotationCrop({ x: NaN, y: 0, width: 50, height: 30 }, { width: 800, height: 600 }, { width: 1600, height: 1200 })).toBeNull();
  });

  it('keeps assets readable after the store is recreated and rejects paths and symlinks', async () => {
    const store = new BrowserAnnotationAssetStore(runtime.directory);
    await store.write('asset-a', Buffer.from('image bytes'));
    expect((await new BrowserAnnotationAssetStore(runtime.directory).read('asset-a')).data).toBe(Buffer.from('image bytes').toString('base64'));
    await expect(store.read('../outside')).rejects.toThrow('Invalid');
    await writeFile(join(runtime.directory, 'outside.txt'), 'outside');
    await symlink(join(runtime.directory, 'outside.txt'), join(runtime.directory, 'asset-link.png'));
    await expect(store.read('asset-link')).rejects.toThrow('Invalid');
  });

  it('rolls back cancelled screenshots even after promotion', async () => {
    const contents = new Contents();
    page(contents);
    const cancelled = await pickBrowserAnnotation('page', pickStyle);
    await completeBrowserAnnotationCapture(cancelled!.assetId!, 'cancel');
    await expect(readBrowserAnnotationAsset(cancelled!.assetId!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await showBrowserAnnotation(cancelled!.capture.id, 1, true)).located).toBe(false);
    const accepted = await pickBrowserAnnotation('page', pickStyle);
    await completeBrowserAnnotationCapture(accepted!.assetId!, 'prepare');
    await completeBrowserAnnotationCapture(accepted!.assetId!, 'cancel');
    await expect(readBrowserAnnotationAsset(accepted!.assetId!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes cancellation behind an in-flight promotion', async () => {
    const contents = new Contents();
    page(contents);
    const captured = await pickBrowserAnnotation('page', pickStyle);
    const original = BrowserAnnotationAssetStore.prototype.promote;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const promote = vi.spyOn(BrowserAnnotationAssetStore.prototype, 'promote').mockImplementation(async function (this: BrowserAnnotationAssetStore, id, destination) {
      await gate;
      await original.call(this, id, destination);
    });
    try {
      const promoting = completeBrowserAnnotationCapture(captured!.assetId!, 'prepare');
      await vi.waitFor(() => expect(promote).toHaveBeenCalled());
      const cancelling = completeBrowserAnnotationCapture(captured!.assetId!, 'cancel');
      release();
      await Promise.all([promoting, cancelling]);
      await expect(readBrowserAnnotationAsset(captured!.assetId!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { release(); promote.mockRestore(); }
  });

  it('rolls back prepared assets on renderer reset but retains committed assets', async () => {
    const contents = new Contents();
    page(contents);
    const pending = await pickBrowserAnnotation('page', pickStyle);
    await completeBrowserAnnotationCapture(pending!.assetId!, 'prepare');
    const committed = await pickBrowserAnnotation('page', pickStyle);
    await completeBrowserAnnotationCapture(committed!.assetId!, 'prepare');
    await completeBrowserAnnotationCapture(committed!.assetId!, 'commit');
    await resetBrowserAnnotationCaptures();
    await expect(readBrowserAnnotationAsset(pending!.assetId!)).rejects.toMatchObject({ code: 'ENOENT' });
    await completeBrowserAnnotationCapture(committed!.assetId!, 'cancel');
    expect((await readBrowserAnnotationAsset(committed!.assetId!)).size).toBeGreaterThan(0);
  });

  it('removes the asset if selection is cancelled while its screenshot is being persisted', async () => {
    const contents = new Contents();
    page(contents);
    const original = BrowserAnnotationAssetStore.prototype.write;
    const write = vi.spyOn(BrowserAnnotationAssetStore.prototype, 'write').mockImplementation(async function (this: BrowserAnnotationAssetStore, id, bytes) {
      await original.call(this, id, bytes);
      cancelBrowserAnnotationPick('page');
    });
    try {
      expect(await pickBrowserAnnotation('page', pickStyle)).toBeNull();
      const id = write.mock.calls[0]![0];
      await expect(readBrowserAnnotationAsset(id)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { write.mockRestore(); }
  });

  it('collects old unreferenced assets while retaining drafts and recent captures', async () => {
    const root = join(runtime.directory, 'browser-annotation-assets');
    const store = new BrowserAnnotationAssetStore(root);
    for (const id of ['draft', 'orphan', 'recent']) await store.write(id, Buffer.from('png'));
    for (const id of ['draft', 'orphan']) await utimes(join(root, `${id}.png`), 1, 1);
    await store.collect(new Set(['draft']), Date.now() - 1000);
    await expect(store.read('orphan')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.read('draft')).size).toBe(3);
    expect((await store.read('recent')).size).toBe(3);
  });

  it('cleans abandoned staging directories on initialization while preserving durable captures', async () => {
    const root = join(runtime.directory, 'browser-annotation-assets');
    const durable = new BrowserAnnotationAssetStore(root);
    const abandoned = new BrowserAnnotationAssetStore(join(root, 'staging', 'old-renderer'));
    await durable.write('kept', Buffer.from('durable'));
    await abandoned.write('abandoned', Buffer.from('temporary'));
    attachBrowserAnnotationWindow(Object.assign(new EventEmitter(), { webContents: new EventEmitter() }) as never);
    page(new Contents());
    await pickBrowserAnnotation('page', pickStyle);
    await expect(abandoned.read('abandoned')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await durable.read('kept')).data).toBe(Buffer.from('durable').toString('base64'));
  });

  it.each(['reload', 'gone', 'closed'] as const)('cleans provisional assets on renderer %s without deleting promoted assets', async (reason) => {
    const owner = new EventEmitter();
    const contents = new EventEmitter();
    attachBrowserAnnotationWindow(Object.assign(owner, { webContents: contents }) as never);
    page(new Contents());
    const accepted = await pickBrowserAnnotation('page', pickStyle);
    await completeBrowserAnnotationCapture(accepted!.assetId!, 'prepare');
    await completeBrowserAnnotationCapture(accepted!.assetId!, 'commit');
    const pending = await pickBrowserAnnotation('page', pickStyle);
    if (reason === 'reload') contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    else if (reason === 'gone') contents.emit('render-process-gone');
    else owner.emit('closed');
    await vi.waitFor(async () => { await expect(readBrowserAnnotationAsset(pending!.assetId!)).rejects.toMatchObject({ code: 'ENOENT' }); });
    expect((await readBrowserAnnotationAsset(accepted!.assetId!)).size).toBeGreaterThan(0);
    await expect(completeBrowserAnnotationCapture('missing-capture', 'prepare')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores markers on valid background pages without focusing or revealing them', async () => {
    const contents = new Contents();
    page(contents);
    const captured = await pickBrowserAnnotation('page', pickStyle);
    contents.focus.mockClear();
    runtime.page!.visible = false;
    expect(await showBrowserAnnotation(captured!.capture.id, 1, false)).toMatchObject({ located: true });
    expect(await showBrowserAnnotation(captured!.capture.id, 1, true)).toMatchObject({ located: false, browserId: 'page' });
    expect(contents.focus).not.toHaveBeenCalled();
  });

  it('captures a visible page with explicit crop geometry and durable asset identity', async () => {
    const contents = new Contents();
    page(contents);
    const result = await pickBrowserAnnotation('page', pickStyle);
    expect(result?.capture.screenshot).toMatchObject({ pixelWidth: 1600, pixelHeight: 1200, crop: { x: 0, y: 0, width: 800, height: 600 } });
    expect(result?.capture.viewport.zoomFactor).toBe(1.25);
    expect(result?.capture.screenshot?.attachmentId).toBe(result?.assetId);
    expect((await readBrowserAnnotationAsset(result!.assetId!)).size).toBeGreaterThan(0);
    expect((await showBrowserAnnotation(result!.capture.id, 1, true)).located).toBe(true);
    runtime.page!.generation += 1;
    expect((await showBrowserAnnotation(result!.capture.id, 1, true)).located).toBe(false);
  });

  it('cancels a pending selection without taking a screenshot', async () => {
    const contents = new Contents();
    contents.pending = true;
    page(contents);
    const pick = pickBrowserAnnotation('page', pickStyle);
    expect(isBrowserAnnotationPicking('page')).toBe(true);
    cancelBrowserAnnotationPick('page');
    expect(await pick).toBeNull();
    expect(contents.capturePage).not.toHaveBeenCalled();
    expect(isBrowserAnnotationPicking('page')).toBe(false);
  });

  it('suspends mouse touch emulation for the pick and restores it on selection, cancel and failure', async () => {
    const contents = new Contents();
    page(contents);
    await pickBrowserAnnotation('page', pickStyle);
    expect(mouseTouch.suspend).toHaveBeenCalledWith(contents);
    expect(mouseTouch.restore).toHaveBeenCalledTimes(1);
    expect(mouseTouch.restore.mock.invocationCallOrder[0]).toBeLessThan(contents.executeJavaScriptInIsolatedWorld.mock.invocationCallOrder.at(-1)!);

    contents.pending = true;
    const pick = pickBrowserAnnotation('page', pickStyle);
    await vi.waitFor(() => expect(mouseTouch.suspend).toHaveBeenCalledTimes(2));
    expect(mouseTouch.restore).toHaveBeenCalledTimes(1);
    cancelBrowserAnnotationPick('page');
    expect(await pick).toBeNull();
    expect(mouseTouch.restore).toHaveBeenCalledTimes(2);

    contents.pending = false;
    contents.executeJavaScriptInIsolatedWorld.mockImplementation(async (_world: number, scripts: { code: string }[]) => scripts[0]!.code.includes('const id =') ? { id: 'invalid' } : true);
    await expect(pickBrowserAnnotation('page', pickStyle)).rejects.toThrow('Invalid browser annotation selection');
    expect(mouseTouch.suspend).toHaveBeenCalledTimes(3);
    expect(mouseTouch.restore).toHaveBeenCalledTimes(3);
  });

  it('rejects a page change during capture and refuses to focus hidden pages', async () => {
    const contents = new Contents();
    page(contents);
    contents.capturePage.mockImplementation(async () => { runtime.page!.generation += 1; return image; });
    expect(await pickBrowserAnnotation('page', pickStyle)).toBeNull();
    runtime.page!.visible = false;
    contents.focus.mockClear();
    await expect(pickBrowserAnnotation('page', pickStyle)).rejects.toThrow('not visible');
    expect(contents.focus).not.toHaveBeenCalled();
  });

  it('emits syntactically valid isolated scripts with escaped caller values', () => {
    const script = browserAnnotationPickerScript('capture', { ...pickStyle, borderColor: '"; throw 1; //' });
    expect(() => new Script(script)).not.toThrow();
    expect(script).toContain('replace(/\\s+/g');
    expect(() => new Script(browserAnnotationCommandScript('locate', 'capture'))).not.toThrow();
  });
});

import { createRenderer, defineComponent, nextTick, reactive, ssrContextKey } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { asBrowserBounds, EMPTY_BROWSER_STATE, type BrowserState } from '../../src/shared/browser';
import { browserDeviceViewBounds } from '../../src/shared/browser-device';

const native = vi.hoisted(() => ({ bridge: null as unknown }));

vi.mock('vue-i18n', async () => {
  const { ref } = await import('vue');
  return { useI18n: () => ({ t: (key: string) => key, locale: ref('en') }) };
});
vi.mock('@moonshot-ai/app-components', () => ({ useComposerBrowserReferenceHost: () => null }));
vi.mock('@moonshot-ai/app-client/composables', () => ({ useConfirmDialog: () => ({ confirm: async () => {} }) }));
vi.mock('../../src/renderer/lib/browserPermissions', async () => {
  const { ref } = await import('vue');
  return { browserPermissionRequests: ref([]), useBrowserPermissionDialog: () => () => {} };
});
vi.mock('../../src/renderer/lib/browserOverlayMenu', async () => {
  const { ref } = await import('vue');
  return { registerBrowserOverlayMenu: () => ({ open: ref(false), toggle: () => {}, close: () => {}, refresh: () => {}, dispose: () => {} }) };
});
vi.mock('../../src/renderer/lib/nativeBrowser', () => ({ getNativeBrowserBridge: () => native.bridge }));

import PanelBrowserTab from '../../src/renderer/components/browser/PanelBrowserTab.vue';

const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
});
let frames: Array<() => void> = [];
let root: { classes: Set<string>; properties: Map<string, string>; classList: unknown; style: unknown };
let rect = { x: 320, y: 48, width: 640, height: 480 };

beforeEach(() => {
  frames = [];
  rect = { x: 320, y: 48, width: 640, height: 480 };
  const classes = new Set<string>();
  const properties = new Map<string, string>();
  root = {
    classes,
    properties,
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    style: { setProperty: (name: string, value: string) => properties.set(name, value), removeProperty: (name: string) => properties.delete(name) },
  };
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible', documentElement: root });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await Promise.resolve();
    await nextTick();
    while (frames.length > 0) for (const callback of frames.splice(0)) callback();
  }
}

const PAGE_STATE: BrowserState = { ...EMPTY_BROWSER_STATE, url: 'https://example.com/', renderable: true };

function mountTab(initial: BrowserState = PAGE_STATE, active = true, browserId = 'browser-1', ownRect: typeof rect | null = null) {
  let release!: () => void;
  let publish: (next: BrowserState) => void = () => {};
  const holeAtRaise: Array<Record<string, string>> = [];
  const bridge = {
    getBrowserState: vi.fn(async () => ({ ...initial })),
    onBrowserState: vi.fn((listener: (browserId: string, next: BrowserState) => void) => { publish = next => listener(browserId, next); return () => {}; }),
    browserSetOccluded: vi.fn((_browserId: string, occluded: boolean) => {
      if (!occluded) return new Promise<void>((resolve) => { release = resolve; });
      holeAtRaise.push(root.classes.has('browser-see-through') ? hole() : {});
      return Promise.resolve();
    }),
    browserSetVisible: vi.fn(),
    browserSetBounds: vi.fn(),
  };
  native.bridge = new Proxy(bridge, { get: (target, key) => (key in target ? target[key as keyof typeof target] : vi.fn()) });
  const props = reactive({ browserId, active, occluded: false });
  let state!: { viewportEl: { value: unknown } };
  const app = renderer.createApp(defineComponent(() => {
    state = (PanelBrowserTab as unknown as { setup: (props: unknown, context: unknown) => typeof state }).setup(props, { expose() {}, emit() {} });
    return () => null;
  }));
  app.provide(ssrContextKey, {});
  app.mount({});
  state.viewportEl.value = { getBoundingClientRect: () => ownRect ?? rect };
  return { app, props, bridge, holeAtRaise, release: () => release(), publish: (next: BrowserState) => publish(next) };
}

function hole(): Record<string, string> {
  return Object.fromEntries(root.properties);
}

const VIEWPORT_HOLE = { '--browser-hole-x': '320px', '--browser-hole-y': '48px', '--browser-hole-w': '640px', '--browser-hole-h': '480px' };

it('keeps the hole over a shown page so the app renderer can rise above it at once', async () => {
  const { app, props, bridge, holeAtRaise } = mountTab();
  await settle();
  expect(root.classes.has('browser-see-through')).toBe(true);
  expect(hole()).toEqual(VIEWPORT_HOLE);
  expect(bridge.browserSetOccluded).not.toHaveBeenCalled();
  bridge.browserSetVisible.mockClear();
  props.occluded = true;
  await nextTick();
  expect(bridge.browserSetOccluded).toHaveBeenCalledExactlyOnceWith('browser-1', true);
  expect(holeAtRaise).toEqual([VIEWPORT_HOLE]);
  await settle();
  expect(bridge.browserSetVisible).not.toHaveBeenCalledWith('browser-1', false);
  app.unmount();
  expect(root.classes.has('browser-see-through')).toBe(false);
  expect(bridge.browserSetOccluded).toHaveBeenLastCalledWith('browser-1', false);
});

it('waits two frames before rising when the hole is punched together with the dialog', async () => {
  const { app, props, bridge, holeAtRaise } = mountTab(PAGE_STATE, false);
  await settle();
  expect(root.classes.has('browser-see-through')).toBe(false);
  props.active = true;
  props.occluded = true;
  await nextTick();
  expect(root.classes.has('browser-see-through')).toBe(true);
  expect(bridge.browserSetOccluded).not.toHaveBeenCalled();
  for (const callback of frames.splice(0)) callback();
  expect(bridge.browserSetOccluded).not.toHaveBeenCalled();
  for (const callback of frames.splice(0)) callback();
  expect(bridge.browserSetOccluded).toHaveBeenCalledExactlyOnceWith('browser-1', true);
  expect(holeAtRaise).toEqual([VIEWPORT_HOLE]);
  app.unmount();
});

it('moves the hole with the viewport when the window resizes during the dialog', async () => {
  const { app, props } = mountTab();
  await settle();
  props.occluded = true;
  await settle();
  rect = { x: 400, y: 48, width: 800, height: 560 };
  const resize = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(([event]) => event === 'resize')![1] as () => void;
  resize();
  await settle();
  expect(hole()).toEqual({ '--browser-hole-x': '400px', '--browser-hole-y': '48px', '--browser-hole-w': '800px', '--browser-hole-h': '560px' });
  app.unmount();
});

it('fits the hole to the emulated device view inside the responsive inset', async () => {
  const device = {
    profileId: 'responsive', orientation: 'portrait', width: 400, height: 300, deviceScaleFactor: 2, mobile: false, touch: false,
    scaleMode: 'fit', requestedScale: 1, displayScale: 1, maxDisplayScale: 1,
  } as const;
  const { app, bridge } = mountTab({ ...PAGE_STATE, device });
  await settle();
  expect(bridge.browserSetBounds).toHaveBeenLastCalledWith('browser-1', { x: 344, y: 72, width: 592, height: 432 });
  expect(hole()).toEqual({ '--browser-hole-x': '440px', '--browser-hole-y': '138px', '--browser-hole-w': '400px', '--browser-hole-h': '300px' });
  app.unmount();
});

function holeEdges(): { left: number; top: number; right: number; bottom: number } {
  const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(key => Number.parseFloat(root.properties.get(`--browser-hole-${key}`) ?? ''));
  return { left: x!, top: y!, right: x! + w!, bottom: y! + h! };
}

function sentBounds(bridge: { browserSetBounds: ReturnType<typeof vi.fn> }): { x: number; y: number; width: number; height: number } {
  return bridge.browserSetBounds.mock.calls.at(-1)![1] as { x: number; y: number; width: number; height: number };
}

it('rounds the hole to the page view bounds when the viewport sits on fractional pixels', async () => {
  for (const fractional of [
    { x: 1106.5, y: 97.5, width: 319.5, height: 967.5 },
    { x: 855.5, y: 97.5, width: 584.5, height: 802.5 },
    { x: 777.2727, y: 88.6364, width: 531.8182, height: 729.5455 },
    { x: 1067.7778, y: 108.3333, width: 532.2222, height: 891.6667 },
    { x: 320.4, y: 48.4, width: 640.2, height: 480.2 },
  ]) {
    rect = fractional;
    const { app, bridge } = mountTab();
    await settle();
    const view = sentBounds(bridge);
    expect(Object.values(view).every(Number.isInteger)).toBe(true);
    expect(view).toEqual(asBrowserBounds(fractional));
    expect(holeEdges()).toEqual({ left: view.x, top: view.y, right: view.x + view.width, bottom: view.y + view.height });
    app.unmount();
  }
});

it('keeps the fractional hole on the emulated device view the main process lays out', async () => {
  const phone = {
    profileId: 'iphone-se', orientation: 'portrait', width: 375, height: 667, deviceScaleFactor: 2, mobile: true, touch: true,
    scaleMode: 'fit', requestedScale: 1, displayScale: 0.75, maxDisplayScale: 0.75,
  } as const;
  const responsive = { ...phone, profileId: 'responsive', width: 401, height: 301, mobile: false, touch: false, displayScale: 1, maxDisplayScale: 1 } as const;
  for (const device of [phone, responsive]) {
    rect = { x: 1106.5, y: 97.5, width: 619.5, height: 967.5 };
    const { app, bridge } = mountTab({ ...PAGE_STATE, device });
    await settle();
    const view = browserDeviceViewBounds(sentBounds(bridge), device);
    const edges = holeEdges();
    expect(Object.values(edges).every(Number.isInteger)).toBe(true);
    expect(edges).toEqual({ left: view.x, top: view.y, right: view.x + view.width, bottom: view.y + view.height });
    app.unmount();
  }
});

it('keeps the hole after the dialog closes and drops it once the hidden page is back below the app renderer', async () => {
  const { app, props, bridge, release } = mountTab();
  await settle();
  props.occluded = true;
  await settle();
  props.occluded = false;
  await settle();
  expect(bridge.browserSetOccluded).toHaveBeenLastCalledWith('browser-1', false);
  expect(hole()).toEqual(VIEWPORT_HOLE);
  release();
  await settle();
  expect(hole()).toEqual(VIEWPORT_HOLE);
  props.occluded = true;
  await settle();
  props.active = false;
  props.occluded = false;
  await settle();
  expect(bridge.browserSetOccluded).toHaveBeenLastCalledWith('browser-1', false);
  expect(root.classes.has('browser-see-through')).toBe(true);
  release();
  await settle();
  expect(root.classes.has('browser-see-through')).toBe(false);
  expect(hole()).toEqual({});
  app.unmount();
});

it('keeps the app renderer raised while the tab is switched away and back under an open dialog', async () => {
  const { app, props, bridge } = mountTab();
  await settle();
  props.occluded = true;
  await settle();
  props.active = false;
  await settle();
  expect(bridge.browserSetVisible).toHaveBeenLastCalledWith('browser-1', false);
  expect(bridge.browserSetOccluded).toHaveBeenCalledExactlyOnceWith('browser-1', true);
  expect(root.classes.has('browser-see-through')).toBe(false);
  props.active = true;
  await settle();
  expect(bridge.browserSetOccluded).toHaveBeenCalledExactlyOnceWith('browser-1', true);
  expect(hole()).toEqual(VIEWPORT_HOLE);
  props.occluded = false;
  await settle();
  expect(bridge.browserSetOccluded).toHaveBeenLastCalledWith('browser-1', false);
  app.unmount();
});

it('follows the shown tab when tabs are switched back and forth before the app renderer is lowered', async () => {
  const first = mountTab(PAGE_STATE, true, 'browser-1');
  const second = mountTab(PAGE_STATE, false, 'browser-2', { x: 40, y: 60, width: 300, height: 200 });
  const secondHole = { '--browser-hole-x': '40px', '--browser-hole-y': '60px', '--browser-hole-w': '300px', '--browser-hole-h': '200px' };
  const show = async (shown: typeof first, hidden: typeof first): Promise<void> => {
    hidden.props.active = false;
    shown.props.active = true;
    await settle();
  };
  await settle();
  first.props.occluded = true;
  second.props.occluded = true;
  await settle();
  await show(second, first);
  await show(first, second);
  expect(first.bridge.browserSetOccluded).toHaveBeenCalledExactlyOnceWith('browser-1', true);
  expect(second.bridge.browserSetOccluded).toHaveBeenCalledExactlyOnceWith('browser-2', true);
  first.props.occluded = false;
  second.props.occluded = false;
  await settle();
  expect(first.bridge.browserSetOccluded).toHaveBeenLastCalledWith('browser-1', false);
  expect(second.bridge.browserSetOccluded).toHaveBeenLastCalledWith('browser-2', false);
  expect(hole()).toEqual(VIEWPORT_HOLE);
  await show(second, first);
  expect(hole()).toEqual(secondHole);
  await show(first, second);
  expect(hole()).toEqual(VIEWPORT_HOLE);
  await show(second, first);
  expect(hole()).toEqual(secondHole);
  first.release();
  second.release();
  await settle();
  expect(hole()).toEqual(secondHole);
  first.app.unmount();
  second.app.unmount();
  expect(root.classes.has('browser-see-through')).toBe(false);
});

it('punches no hole where the app renderer draws the tab itself', async () => {
  for (const initial of [EMPTY_BROWSER_STATE, { ...PAGE_STATE, error: 'net::ERR_FAILED' }]) {
    const { app, props, bridge } = mountTab(initial);
    await settle();
    props.occluded = true;
    await settle();
    expect(bridge.browserSetOccluded).toHaveBeenCalledExactlyOnceWith('browser-1', true);
    expect(root.classes.has('browser-see-through')).toBe(false);
    app.unmount();
  }
});

it('never punches a hole for an inactive tab', async () => {
  const { app, props, bridge } = mountTab(PAGE_STATE, false);
  await settle();
  props.occluded = true;
  await settle();
  expect(bridge.browserSetOccluded).not.toHaveBeenCalled();
  expect(root.classes.has('browser-see-through')).toBe(false);
  app.unmount();
});

it('waits for the native page to become renderable before punching the hole', async () => {
  const restoring = { ...EMPTY_BROWSER_STATE, url: 'https://example.com/', loading: true };
  const { app, props, publish } = mountTab(restoring);
  await settle();
  props.occluded = true;
  await settle();
  expect(root.classes.has('browser-see-through')).toBe(false);
  publish({ ...restoring, renderable: true });
  await settle();
  expect(hole()).toEqual(VIEWPORT_HOLE);
  app.unmount();
});

import { createRenderer, defineComponent, h, markRaw, nextTick, reactive, ssrContextKey } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import BrowserAddressBar from '../../src/renderer/components/browser/BrowserAddressBar.vue';

const mocks = vi.hoisted(() => ({ getData: vi.fn(), open: vi.fn(), close: vi.fn() }));
vi.mock('../../src/renderer/lib/nativeBrowser', () => ({ getNativeBrowserBridge: () => ({ browserGetData: mocks.getData }) }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@moonshot-ai/app-core/lib', () => ({ isMacosDesktop: true }));
vi.mock('@moonshot-ai/app-ui', async () => ({
  Input: (await import('../../../../packages/app-ui/src/components/ui/Input.vue')).default,
  Icon: { render: () => null },
  openDialogCount: (await import('vue')).ref(0),
  registerExternalMenuSurface: () => () => {},
}));

interface HostNode {
  tag?: string;
  children: HostNode[];
  props: Record<string, unknown>;
  parent?: HostNode;
}
interface AddressBarState {
  root: { value: unknown };
  input: { value: unknown };
  onMouseDown: (event: { target: unknown; button: number; ctrlKey?: boolean }) => void;
  onPointerRelease: () => void;
  onFocus: () => Promise<void>;
  onBlur: (event: { relatedTarget: null }) => void;
  update: (value: string) => void;
  onKeydown: (event: unknown) => void;
}
const renderer = createRenderer<HostNode, HostNode>({
  patchProp: (node, key, _previous, next) => { node.props[key] = next; },
  insert: (node, parent) => { node.parent = parent; parent.children.push(node); },
  remove: () => {},
  createElement: (tag) => ({ tag, children: [], props: {}, select() {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) }),
  createText: () => ({ children: [], props: {} }),
  createComment: () => ({ children: [], props: {} }),
  setText: () => {}, setElementText: () => {},
  parentNode: (node) => node.parent ?? null, nextSibling: () => null,
  setScopeId: () => {},
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(['type', 'Escape', 'Enter', 'restart'] as const)('handles %s while address history is still loading', async (action) => {
  let onResize!: () => void;
  let onClosed!: (payload: unknown) => void;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { onResize = callback; } observe() {} disconnect = disconnect; });
  let resolve!: (data: unknown) => void;
  mocks.getData.mockImplementation(() => new Promise((done) => { resolve = done; }));
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: (callback: (payload: unknown) => void) => { onClosed = callback; return () => {}; },
    },
  });
  const props = reactive({ modelValue: '', url: 'https://example.com/' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  const root: HostNode = { children: [], props: {} };
  app.mount(root);
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  const focused = state.onFocus();
  if (action === 'restart') {
    state.onKeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    state.update('example');
  } else if (action === 'type') state.update('example');
  else state.onKeydown({ key: action, preventDefault() {}, stopPropagation() {} });
  await nextTick();
  resolve({ history: [{ id: 'visit', url: 'https://example.com/', title: 'Example', favicon: 'https://example.com/favicon.ico', visitedAt: 1 }] });
  await focused;
  await nextTick();
  expect(mocks.getData).toHaveBeenCalledOnce();
  expect(mocks.open).toHaveBeenCalledTimes(action === 'type' || action === 'restart' ? 1 : 0);
  if (action === 'type' || action === 'restart') expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Example', favicon: 'https://example.com/favicon.ico' })] }));
  if (action === 'type') {
    state.onBlur({ relatedTarget: null });
    await state.onFocus();
    expect(mocks.getData).toHaveBeenCalledOnce();
    state.update('example.com');
    expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Example', favicon: 'https://example.com/favicon.ico' })] }));
    state.root.value = { getBoundingClientRect: () => ({ x: 100, y: 0, width: 900, height: 30 }) };
    onResize();
    expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ width: 900, anchor: { x: 100, y: 0, width: 900, height: 30 } }));
    onClosed({ menuId: mocks.open.mock.lastCall?.[0].menuId, reason: 'action' });
    const opened = mocks.open.mock.calls.length;
    await state.onFocus();
    expect(mocks.open).toHaveBeenCalledTimes(opened);
    expect(mocks.getData).toHaveBeenCalledOnce();
    for (const [index, reason] of ['window-blur', 'dismiss'].entries()) {
      state.update('example');
      state.onBlur({ relatedTarget: null });
      onClosed({ menuId: mocks.open.mock.lastCall?.[0].menuId, reason });
      state.onMouseDown({ target: null, button: 0 });
      const refocused = state.onFocus();
      await nextTick();
      expect(mocks.getData).toHaveBeenCalledTimes(index + 2);
      resolve({ history: [{ id: 'new', url: 'https://example.com/new', title: 'New', visitedAt: 2 }] });
      await refocused;
      expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'New' })] }));
    }
  }
  app.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('updates the open suggestion menu in place while typing', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getData.mockResolvedValue({ history: [
    { id: 'one', url: 'https://example.com/one', title: 'One', visitedAt: 1 },
    { id: 'two', url: 'https://example.com/two', title: 'Two', visitedAt: 2 },
  ] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();
  expect(mocks.open).toHaveBeenCalledOnce();

  for (const value of ['e', 'ex', 'example.com/', 'example.com/t']) state.update(value);

  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.open).toHaveBeenCalledTimes(5);
  expect(new Set(mocks.open.mock.calls.map(([request]) => request.menuId)).size).toBe(1);
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Two' })] }));
  app.unmount();
});

it('resolves a stale suggestion click to the entry it was rendered for after the list changes', async () => {
  let onAction!: (payload: unknown) => void;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getData.mockResolvedValue({ history: [
    { id: 'a', url: 'https://alpha.test/', title: 'Alpha', visitedAt: 3 },
    { id: 'b', url: 'https://beta.test/', title: 'Beta', visitedAt: 2 },
    { id: 'c', url: 'https://beta.test/docs', title: 'Beta Docs', visitedAt: 1 },
  ] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: (callback: (payload: unknown) => void) => { onAction = callback; return () => {}; }, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  const navigated: string[] = [];
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {},
      emit: (name: string, value: string) => {
        if (name === 'update:modelValue') props.modelValue = value;
        if (name === 'navigate') navigated.push(props.modelValue);
      },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();
  const staleClick = (label: string): void => {
    const [shown] = mocks.open.mock.lastCall!;
    const itemId = shown.items.find((item: { label: string }) => item.label === label).id;
    state.update('beta');
    const [refreshed] = mocks.open.mock.lastCall!;
    expect(refreshed.menuId).toBe(shown.menuId);
    expect(refreshed.items.map((item: { label: string }) => item.label)).toEqual(['Beta', 'Beta Docs']);
    onAction({ menuId: shown.menuId, itemId });
  };

  staleClick('Beta');
  expect(navigated).toEqual(['https://beta.test/']);

  state.update('');
  staleClick('Alpha');
  expect(navigated).toEqual(['https://beta.test/']);

  state.update('beta');
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Beta', selected: false }), expect.objectContaining({ label: 'Beta Docs', selected: true })] }));
  state.onKeydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  expect(navigated).toEqual(['https://beta.test/', 'https://beta.test/docs']);
  app.unmount();
});

it('opens suggestions on click focus and typing, but not on programmatic focus', async () => {
  let onClosed!: (payload: unknown) => void;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let resolve!: (data: unknown) => void;
  mocks.getData.mockImplementation(() => new Promise((done) => { resolve = done; }));
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('Node', class {});
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: (callback: (payload: unknown) => void) => { onClosed = callback; return () => {}; },
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  let exposed!: { focus: () => void; select: () => void };
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose(api: unknown) { exposed = api as typeof exposed; },
      emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  const root: HostNode = { children: [], props: {} };
  app.mount(root);
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  const inputEl = markRaw({});
  state.input.value = { el: inputEl, select() {}, focus() {} };
  const entry = { id: 'visit', url: 'https://example.com/', title: 'Example', favicon: 'https://example.com/favicon.ico', visitedAt: 1 };

  await state.onFocus();
  await nextTick();
  expect(mocks.getData).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();

  state.onMouseDown({ target: inputEl, button: 2 });
  expect(mocks.getData).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();

  state.onMouseDown({ target: inputEl, button: 0, ctrlKey: true });
  expect(mocks.getData).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();

  state.onMouseDown({ target: inputEl, button: 0 });
  expect(mocks.getData).toHaveBeenCalledOnce();
  resolve({ history: [entry] });
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Example', selected: false })] }));

  exposed.focus();
  expect(mocks.close).toHaveBeenCalledOnce();
  onClosed({ menuId: mocks.open.mock.lastCall?.[0].menuId, reason: 'dismiss' });

  state.onMouseDown({ target: null, button: 0 });
  state.onPointerRelease();
  await state.onFocus();
  await nextTick();
  expect(mocks.getData).toHaveBeenCalledOnce();
  expect(mocks.open).toHaveBeenCalledOnce();

  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  expect(mocks.getData).toHaveBeenCalledTimes(2);
  const second = { id: 'visit-2', url: 'https://example.com/two', title: 'Example Two', favicon: 'https://example.com/favicon.ico', visitedAt: 2 };
  resolve({ history: [entry, second] });
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(3));
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Example', selected: false }), expect.objectContaining({ label: 'Example Two', selected: true })] }));

  exposed.focus();
  expect(mocks.close).toHaveBeenCalledTimes(2);
  onClosed({ menuId: mocks.open.mock.lastCall?.[0].menuId, reason: 'dismiss' });

  state.onMouseDown({ target: null, button: 0 });
  const clicked = state.onFocus();
  expect(mocks.getData).toHaveBeenCalledTimes(3);
  resolve({ history: [entry] });
  await clicked;
  expect(mocks.open).toHaveBeenCalledTimes(4);
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Example', selected: false })] }));

  exposed.focus();
  onClosed({ menuId: mocks.open.mock.lastCall?.[0].menuId, reason: 'dismiss' });
  await state.onFocus();
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  state.onKeydown({ key: 'ArrowUp', preventDefault() {}, stopPropagation() {} });
  expect(mocks.getData).toHaveBeenCalledTimes(4);
  resolve({ history: [entry, second] });
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(6));
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Example', selected: false }), expect.objectContaining({ label: 'Example Two', selected: true })] }));

  state.onMouseDown({ target: inputEl, button: 2 });
  expect(mocks.close).toHaveBeenCalledTimes(4);
  onClosed({ menuId: mocks.open.mock.lastCall?.[0].menuId, reason: 'dismiss' });

  await state.onFocus();
  mocks.getData.mockImplementationOnce(() => Promise.reject(new Error('unavailable')));
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  await new Promise((done) => { setTimeout(done, 0); });
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  expect(mocks.getData).toHaveBeenCalledTimes(6);
  resolve({ history: [entry, second] });
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(8));
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Example', selected: true }), expect.objectContaining({ label: 'Example Two', selected: false })] }));

  exposed.focus();
  expect(mocks.close).toHaveBeenCalledTimes(5);
  onClosed({ menuId: mocks.open.mock.lastCall?.[0].menuId, reason: 'dismiss' });
  await state.onFocus();
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  expect(mocks.getData).toHaveBeenCalledTimes(7);
  state.onMouseDown({ target: inputEl, button: 2 });
  state.onMouseDown({ target: inputEl, button: 0 });
  expect(mocks.getData).toHaveBeenCalledTimes(7);
  resolve({ history: [entry, second] });
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(9));
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Example', selected: false }), expect.objectContaining({ label: 'Example Two', selected: false })] }));

  exposed.focus();
  expect(mocks.close).toHaveBeenCalledTimes(6);
  onClosed({ menuId: mocks.open.mock.lastCall?.[0].menuId, reason: 'dismiss' });
  await state.onFocus();
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  expect(mocks.getData).toHaveBeenCalledTimes(8);
  state.onMouseDown({ target: inputEl, button: 0 });
  expect(mocks.getData).toHaveBeenCalledTimes(8);
  resolve({ history: [entry, second] });
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(10));
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Example', selected: false }), expect.objectContaining({ label: 'Example Two', selected: false })] }));

  exposed.focus();
  expect(mocks.close).toHaveBeenCalledTimes(7);
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  expect(mocks.open).toHaveBeenCalledTimes(12);
  expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'Example', selected: true }), expect.objectContaining({ label: 'Example Two', selected: false })] }));
  onClosed({ menuId: mocks.close.mock.lastCall?.[0], reason: 'dismiss' });
  expect(mocks.open).toHaveBeenCalledTimes(12);

  app.unmount();
});

it('merges duplicate pages, highlights the query and shows where lookalike URLs differ', async () => {
  let onAction!: (payload: unknown) => void;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const dir = 'https://www.google.com/maps/dir/University+of+Oregon,+Eugene,+OR/St.+Louis,+MO+63105,+USA';
  const data = 'data=!4m14!4m13!1m5!1m1!1s0x54c11e3d8e4f0a6b:0x3a1f1c1b2a9e8d7c!2m2!1d-123.0726055!2d44.0448302!1m5!1m1!1s0x87d8cb2f3b6a5c01:0x2f5b8b0a1e3c4d5e!2m2!1d-90.3371889!2d38.6425518';
  const title = 'University of Oregon to St. Louis, MO 63105, USA - Google Maps';
  const first = `${dir}/@41.3717265,-111.3170312,5z/${data}!3e0`;
  const second = `${dir}/@40.9125081,-106.2944017,4z/${data}!3e0`;
  mocks.getData.mockResolvedValue({ history: [
    { id: 'clock', url: `${first}#x`, title, visitedAt: 4 },
    { id: 'second', url: second, title, favicon: 'https://www.google.com/favicon.ico', visitedAt: 3 },
    { id: 'favicon', url: first, title, favicon: 'https://www.google.com/favicon.ico', visitedAt: 2 },
    { id: 'site', url: 'https://oregon.gov/', title: 'Oregon.gov Home Page', visitedAt: 1 },
  ] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: (callback: (payload: unknown) => void) => { onAction = callback; return () => {}; }, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  const navigated: string[] = [];
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {},
      emit: (name: string, value: string) => {
        if (name === 'update:modelValue') props.modelValue = value;
        if (name === 'navigate') navigated.push(props.modelValue);
      },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();
  state.update('oregon');

  const [shown] = mocks.open.mock.lastCall!;
  expect(shown.items).toEqual([
    expect.objectContaining({
      label: title.slice(0, 48), favicon: 'https://www.google.com/favicon.ico',
      description: 'https://www.google.com/…+Oregon…/@41.3717265,-111',
    }),
    expect.objectContaining({
      label: title.slice(0, 48),
      description: 'https://www.google.com/…+Oregon…/@40.9125081,-106',
    }),
    expect.objectContaining({
      label: 'Oregon.gov Home Page',
      description: 'https://oregon.gov/',
    }),
  ]);
  expect(shown.items[0].description).not.toBe(shown.items[1].description);
  expect(shown.query).toBe('oregon');
  expect(shown.items.some((item: object) => 'labelHighlights' in item || 'descriptionHighlights' in item)).toBe(false);

  const firstId = shown.items[0].id;
  state.update('oregon.');
  state.update('oregon');
  expect(mocks.open.mock.lastCall![0].items[0].id).toBe(firstId);
  expect(new Set(mocks.open.mock.calls.map(([request]) => request.menuId)).size).toBe(1);
  state.update('oregon.gov');
  onAction({ menuId: shown.menuId, itemId: firstId });
  expect(navigated).toEqual([]);

  state.update('oregon');
  onAction({ menuId: mocks.open.mock.lastCall![0].menuId, itemId: firstId });
  expect(navigated).toEqual([`${first}#x`]);

  state.update('oregon');
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  expect(mocks.open.mock.lastCall![0].items.map((item: { selected: boolean }) => item.selected)).toEqual([false, true, false]);
  state.onKeydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  expect(navigated).toEqual([`${first}#x`, second]);
  app.unmount();
});

it('filters by every query word and keeps suggestion ids while refining', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getData.mockResolvedValue({ history: [
    { id: 'docs', url: 'https://example.com/docs', title: 'Reference', visitedAt: 3 },
    { id: 'blog', url: 'https://example.com/blog', title: 'Blog', visitedAt: 2 },
    { id: 'guide', url: 'https://example.com/guide', title: 'Example docs home', visitedAt: 1 },
  ] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  const navigated: string[] = [];
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {},
      emit: (name: string, value: string) => {
        if (name === 'update:modelValue') props.modelValue = value;
        if (name === 'navigate') navigated.push(props.modelValue);
      },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('example');
  const ids = new Map(mocks.open.mock.lastCall![0].items.map((item: { label: string; id: string }) => [item.label, item.id]));
  state.update('example docs');
  const [refined] = mocks.open.mock.lastCall!;
  expect(refined.items.map((item: { label: string }) => item.label)).toEqual(['Example docs home', 'Reference']);
  expect(refined.items.map((item: { label: string; id: string }) => item.id)).toEqual([ids.get('Example docs home'), ids.get('Reference')]);
  expect(refined).toMatchObject({ query: 'example docs' });
  expect(refined.items[1]).toMatchObject({ description: 'https://example.com/docs' });
  expect(mocks.close).not.toHaveBeenCalled();
  expect(new Set(mocks.open.mock.calls.map(([request]) => request.menuId)).size).toBe(1);

  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  state.onKeydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  expect(navigated).toEqual(['https://example.com/docs']);

  state.update(`${'a '.repeat(100000)}docs`);
  expect(mocks.open.mock.lastCall![0].query).toBe('a docs');
  app.unmount();
});

it('shows and opens the merged URL that matched the query', async () => {
  let onAction!: (payload: unknown) => void;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getData.mockResolvedValue({ history: [
    { id: 'variant', url: 'https://example.com/page#install', title: 'Install section', visitedAt: 2 },
    { id: 'kept', url: 'https://example.com/page', title: 'Page', favicon: 'https://example.com/favicon.ico', visitedAt: 1 },
  ] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: (callback: (payload: unknown) => void) => { onAction = callback; return () => {}; }, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  const navigated: string[] = [];
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {},
      emit: (name: string, value: string) => {
        if (name === 'update:modelValue') props.modelValue = value;
        if (name === 'navigate') navigated.push(props.modelValue);
      },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('page');
  const [plain] = mocks.open.mock.lastCall!;
  expect(plain.items).toEqual([expect.objectContaining({ label: 'Install section', description: 'https://example.com/page#install', favicon: 'https://example.com/favicon.ico' })]);

  state.update('install');
  const [matched] = mocks.open.mock.lastCall!;
  expect(matched.menuId).toBe(plain.menuId);
  expect(matched.items).toEqual([expect.objectContaining({
    label: 'Install section', favicon: 'https://example.com/favicon.ico',
    description: 'https://example.com/page#install',
  })]);
  expect(matched.items[0].id).toBe(plain.items[0].id);
  expect(matched.query).toBe('install');

  onAction({ menuId: matched.menuId, itemId: matched.items[0].id });
  expect(navigated).toEqual(['https://example.com/page#install']);

  state.update('page');
  const [again] = mocks.open.mock.lastCall!;
  expect(again.items[0].id).toBe(plain.items[0].id);
  onAction({ menuId: again.menuId, itemId: matched.items[0].id });
  expect(navigated).toEqual(['https://example.com/page#install', 'https://example.com/page#install']);
  state.update('install');
  state.onKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  state.onKeydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  expect(navigated).toEqual(['https://example.com/page#install', 'https://example.com/page#install', 'https://example.com/page#install']);
  app.unmount();
});

it('highlights long pasted queries through their clipped fragments only', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const longUrl = `https://example.com/documentationreference/${'a'.repeat(352)}`;
  mocks.getData.mockResolvedValue({ history: [{ id: 'long', url: longUrl, title: 'Documentation…Reference', visitedAt: 1 }] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('documentationreference');
  expect(mocks.open.mock.lastCall![0].query).toBe('documentationreference');

  state.update(longUrl);
  expect(mocks.open.mock.lastCall![0].items[0].descriptionRanges).toEqual([{ start: 0, end: 48 }]);
  expect(mocks.open.mock.lastCall![0].query).toBe(longUrl);
  app.unmount();
});

it('keeps the label non-empty when the first grapheme exceeds the narrowest bar', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const family = '👨🏿‍👩🏿‍👧🏿‍👦🏿';
  mocks.getData.mockResolvedValue({ history: [{ id: 'family', url: 'https://example.com/oregon', title: family, visitedAt: 1 }] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 180, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('oregon');
  expect(mocks.open.mock.lastCall![0].items[0].label).toBe(family);
  app.unmount();
});

it('keeps visible fragments ahead of full terms in the highlight query', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const longUrl = `https://example.com/${'a'.repeat(1100)}`;
  mocks.getData.mockResolvedValue({ history: [{ id: 'long', url: longUrl, title: 'Page', visitedAt: 1 }] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update(longUrl);
  expect(mocks.open.mock.lastCall![0].query).toHaveLength(1024);
  expect(mocks.open.mock.lastCall![0].items[0].descriptionRanges).toEqual([{ start: 0, end: 48 }]);
  app.unmount();
});

it('caps per-item highlight ranges at the schema limit', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getData.mockResolvedValue({ history: [{ id: 'many', url: 'https://example.com/', title: `${'a '.repeat(67)}oregon`, visitedAt: 1 }] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 2000, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('a');
  const [item] = mocks.open.mock.lastCall![0].items;
  expect(item.labelRanges).toHaveLength(64);
  expect(item.labelRanges.at(-1)).toEqual({ start: 126, end: 127 });
  app.unmount();
});

it('does not treat a natural ellipsis as a clip-produced fragment', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getData.mockResolvedValue({ history: [{ id: 'ellipsis', url: 'https://example.com/documentationreference', title: `Documentation…Reference ${'x'.repeat(100)}`, visitedAt: 1 }] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('documentationreference');
  expect(mocks.open.mock.lastCall![0].items[0].labelRanges).toEqual([]);
  app.unmount();
});

it('merges overlapping highlight ranges before sending', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getData.mockResolvedValue({ history: [{ id: 'overlap', url: 'https://example.com/', title: `prefix${'a'.repeat(60)}`, visitedAt: 1 }] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update(`pre ${'prefix'.concat('a'.repeat(55))}`);
  expect(mocks.open.mock.lastCall![0].items[0].labelRanges).toEqual([{ start: 0, end: 48 }]);
  app.unmount();
});

it('keeps fragment emphasis on the row that produced it', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getData.mockResolvedValue({ history: [
    { id: 'prefixed', url: 'https://example.com/', title: `prefix${'a'.repeat(60)}`, visitedAt: 2 },
    { id: 'run', url: `https://example.com/${'a'.repeat(60)}`, title: 'a'.repeat(43), visitedAt: 1 },
  ] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('a'.repeat(60));
  const [shown] = mocks.open.mock.lastCall!;
  expect(shown.items[0].labelRanges).toEqual([{ start: 6, end: 48 }]);
  expect(shown.items[1].labelRanges).toEqual([]);
  expect(shown.items[1].descriptionRanges).toEqual([{ start: 20, end: 48 }]);
  app.unmount();
});

it('extracts the query-owned substring of a clipped fragment', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getData.mockResolvedValue({ history: [{ id: 'prefixed', url: 'https://example.com/', title: `prefix${'a'.repeat(60)}`, visitedAt: 1 }] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('a'.repeat(60));
  expect(mocks.open.mock.lastCall![0].items[0].labelRanges).toEqual([{ start: 6, end: 48 }]);
  expect(mocks.open.mock.lastCall![0].query).toBe('a'.repeat(60));
  app.unmount();
});

it('keeps the first match inside the title and URL limits', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const longTitle = `${'Trail report '.repeat(22)}Oregon coast`;
  const longUrl = `https://example.com/search?${'a=1&'.repeat(300)}q=oregon`;
  mocks.getData.mockResolvedValue({ history: [{ id: 'long', url: longUrl, title: longTitle, visitedAt: 1 }] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();
  state.update('oregon');
  const [item] = mocks.open.mock.lastCall![0].items;
  expect(item.label.length).toBeLessThanOrEqual(256);
  expect(item.label).toMatch(/^….{24}Oregon coast$/);
  expect(item.description.length).toBeLessThanOrEqual(1024);
  expect(item.description).toMatch(/^….{24}oregon$/);
  state.update('trail');
  expect(mocks.open.mock.lastCall![0].items[0].label).toBe(longTitle.slice(0, 49));
  app.unmount();
});

it('bounds the query before distinguishing suggestion URLs', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const filler = Array.from({ length: 150 }, (_, index) => `word${index}`).join(' ');
  const urlOf = (slot: string) => `https://example.com/a/${'p'.repeat(20)}/oregon/${'p'.repeat(20)}/${slot}/tail`;
  mocks.getData.mockResolvedValue({ history: [
    { id: 'first', url: urlOf('1'), title: filler, visitedAt: 2 },
    { id: 'second', url: urlOf('2'), title: filler, visitedAt: 1 },
  ] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update(`${filler} oregon`);
  const [shown] = mocks.open.mock.lastCall!;
  expect(shown.items.map((item: { description: string }) => item.description)).toEqual([
    `https://example.com/…/${'p'.repeat(20)}/1/tail`,
    `https://example.com/…/${'p'.repeat(20)}/2/tail`,
  ]);
  app.unmount();
});

it('splits emphasis fragments only on the ellipsis the clip inserted', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const title = `Documentation…Reference ${'z'.repeat(120)}Target`;
  mocks.getData.mockResolvedValue({ history: [{ id: 'natural', url: 'https://example.com/documentationreference', title, visitedAt: 1 }] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('documentationreference documentation target');
  const [item] = mocks.open.mock.lastCall![0].items;
  expect(item.label).toBe(`Documentation…Reference ${'z'.repeat(13)}…${'z'.repeat(24)}Target`);
  expect(item.labelRanges).toEqual([{ start: 0, end: 13 }, { start: 62, end: 68 }]);
  app.unmount();
});

it('keeps a query hit that overlaps the difference anchor', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getData.mockResolvedValue({ history: [
    { id: 'upper', url: 'https://e.co/aaaXquerytail', title: 'Page', visitedAt: 2 },
    { id: 'lower', url: 'https://e.co/aaaxquerytail', title: 'Page', visitedAt: 1 },
  ] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 180, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('xquery');
  const [shown] = mocks.open.mock.lastCall!;
  expect(shown.items.map((item: { description: string }) => item.description)).toEqual(['…Xquerytail', '…xquerytail']);
  expect(shown.items.map((item: { descriptionRanges: unknown }) => item.descriptionRanges)).toEqual([[{ start: 1, end: 7 }], [{ start: 1, end: 7 }]]);
  app.unmount();
});

it('caps emphasis at 64 ranges without spanning the gaps between them', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const title = `${'a '.repeat(64)}${'x'.repeat(100)}a`;
  mocks.getData.mockResolvedValue({ history: [{ id: 'scattered', url: 'https://example.com/', title, visitedAt: 1 }] });
  vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', {
    addEventListener() {}, removeEventListener() {},
    kimiDesktop: { browserOverlaySupported: true,
      browserOverlayOpenMenu: mocks.open, browserOverlayCloseMenu: mocks.close,
      onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
    },
  });
  const props = reactive({ modelValue: '', url: '' });
  let state!: AddressBarState;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserAddressBar as unknown as { setup: (props: unknown, context: unknown) => AddressBarState }).setup(props, {
      expose() {}, emit: (name: string, value: string) => { if (name === 'update:modelValue') props.modelValue = value; },
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.root.value = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 1700, height: 30 }) };
  state.input.value = { select() {} };
  state.onMouseDown({ target: null, button: 0 });
  await state.onFocus();

  state.update('a');
  const [item] = mocks.open.mock.lastCall![0].items;
  expect(item.label).toBe(title);
  expect(item.labelRanges).toHaveLength(64);
  expect(item.labelRanges.at(-1)).toEqual({ start: 126, end: 127 });
  expect(item.labelRanges.every((range: { start: number; end: number }) => range.end - range.start === 1)).toBe(true);
  app.unmount();
});

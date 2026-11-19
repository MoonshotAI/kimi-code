import { createRenderer, defineComponent, h, reactive, ref, ssrContextKey } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import BrowserSiteInfo from '../../src/renderer/components/browser/BrowserSiteInfo.vue';
import { BROWSER_SITE_PERMISSIONS } from '../../src/shared/browser-sites';

const mocks = vi.hoisted(() => ({
  bridge: {
    browserGetSite: vi.fn(),
    browserGetSystemPermissionStates: vi.fn(),
    browserOpenSystemPermissionSettings: vi.fn(async () => undefined),
    browserSetSitePermission: vi.fn(),
    browserSetSiteAutoplay: vi.fn(),
    browserSetSiteSound: vi.fn(),
    browserClearSiteData: vi.fn(),
  },
  confirm: vi.fn(async (options: { action: () => Promise<unknown> }) => { await options.action(); return true; }),
  menu: { refresh: vi.fn(), show: vi.fn() },
  registration: undefined as undefined | { items: () => Array<Record<string, unknown>>; onSelect: (id: string) => void },
}));

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key }) }));
vi.mock('../../src/renderer/lib/nativeBrowser', () => ({ getNativeBrowserBridge: () => mocks.bridge }));
vi.mock('../../src/renderer/lib/browserOverlayMenu', () => ({
  registerBrowserOverlayMenu: (registration: { items: () => Array<Record<string, unknown>>; onSelect: (id: string) => void }) => {
    mocks.registration = registration;
    return { open: ref(false), close: vi.fn(), dispose: vi.fn(), refresh: mocks.menu.refresh, request: (load: () => Promise<unknown>) => load(), show: mocks.menu.show };
  },
}));
vi.mock('@moonshot-ai/app-client/composables', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));

interface HostNode {
  tag?: string;
  children: HostNode[];
  props: Record<string, unknown>;
  parent?: HostNode;
}
const renderer = createRenderer<HostNode, HostNode>({
  patchProp: (node, key, _previous, next) => { node.props[key] = next; },
  insert: (node, parent) => { node.parent = parent; parent.children.push(node); },
  remove: () => {},
  createElement: (tag) => ({ tag, children: [], props: {} }),
  createText: () => ({ children: [], props: {} }),
  createComment: () => ({ children: [], props: {} }),
  setText: () => {}, setElementText: () => {},
  parentNode: (node) => node.parent ?? null, nextSibling: () => null,
  setScopeId: () => {},
});

interface SiteInfoBindings {
  button: { value: unknown };
  toggle: () => Promise<void>;
  select: (id: string) => Promise<void>;
}

function mount(props: { url: string }): SiteInfoBindings {
  let state!: SiteInfoBindings;
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserSiteInfo as unknown as { setup: (props: unknown, context: unknown) => SiteInfoBindings }).setup(props, { expose() {}, emit: vi.fn() });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  return state;
}

afterEach(() => { vi.clearAllMocks(); });

it('marks OS-denied permissions disabled with a notice that opens system settings', async () => {
  mocks.bridge.browserGetSite.mockResolvedValue({ origin: 'https://example.test', lastVisitedAt: 0, permissions: {}, cookieCount: 0 });
  mocks.bridge.browserGetSystemPermissionStates.mockResolvedValue(['camera']);
  const state = mount(reactive({ url: 'https://example.test/path' }));
  state.button.value = { el: { getClientRects: () => [{ width: 1 }] } };
  await state.toggle();

  const items = mocks.registration!.items();
  const camera = items.find((item) => item['id'] === 'camera')!;
  expect(camera).toMatchObject({
    disabled: true,
    notice: { message: 'browser.sites.systemPermissionDenied', linkLabel: 'browser.sites.openSystemSettings', action: 'camera.system-settings' },
  });
  const microphone = items.find((item) => item['id'] === 'microphone')!;
  expect(microphone).not.toHaveProperty('notice');
  expect(microphone).not.toHaveProperty('disabled');

  await state.select('camera.system-settings');
  expect(mocks.bridge.browserOpenSystemPermissionSettings).toHaveBeenCalledWith('camera');
});

it('renders every permission interactive when the OS grants access', async () => {
  mocks.bridge.browserGetSite.mockResolvedValue({ origin: 'https://example.test', lastVisitedAt: 0, permissions: { camera: 'allow' }, cookieCount: 2 });
  mocks.bridge.browserGetSystemPermissionStates.mockResolvedValue([]);
  const state = mount(reactive({ url: 'https://example.test/path' }));
  state.button.value = { el: { getClientRects: () => [{ width: 1 }] } };
  await state.toggle();

  const items = mocks.registration!.items();
  const choices = items.filter((item) => item['kind'] === 'choices');
  expect(choices.map((item) => item['id'])).toEqual(['autoplay', 'sound', ...BROWSER_SITE_PERMISSIONS]);
  for (const item of choices) {
    expect(item).not.toHaveProperty('notice');
    expect(item).not.toHaveProperty('disabled');
  }
  expect(choices.find((item) => item['id'] === 'camera')?.['value']).toBe('camera.allow');
});

it('updates the origin autoplay override without treating it as a permission', async () => {
  mocks.bridge.browserGetSite.mockResolvedValue({ origin: 'https://example.test', lastVisitedAt: 0, permissions: {}, autoplay: 'allow', cookieCount: 0 });
  mocks.bridge.browserGetSystemPermissionStates.mockResolvedValue([]);
  mocks.bridge.browserSetSiteAutoplay.mockResolvedValue({ origin: 'https://example.test', lastVisitedAt: 0, permissions: {}, autoplay: 'block', cookieCount: 0 });
  const state = mount(reactive({ url: 'https://example.test/path' }));
  state.button.value = { el: { getClientRects: () => [{ width: 1 }] } };
  await state.toggle();
  expect(mocks.registration!.items().find(item => item['id'] === 'autoplay')?.['value']).toBe('autoplay.allow');
  await state.select('autoplay.block');
  expect(mocks.bridge.browserSetSiteAutoplay).toHaveBeenCalledExactlyOnceWith('https://example.test', 'block');
  expect(mocks.bridge.browserSetSitePermission).not.toHaveBeenCalled();
  expect(mocks.registration!.items().find(item => item['id'] === 'autoplay')?.['value']).toBe('autoplay.block');
  expect(mocks.registration!.items().find(item => item['id'] === 'sound')?.['value']).toBe('sound.default');
  mocks.bridge.browserSetSiteSound.mockResolvedValue({ origin: 'https://example.test', lastVisitedAt: 0, permissions: {}, autoplay: 'block', sound: 'on', cookieCount: 0 });
  await state.select('sound.on');
  expect(mocks.bridge.browserSetSiteSound).toHaveBeenCalledExactlyOnceWith('https://example.test', 'on');
  expect(mocks.registration!.items().find(item => item['id'] === 'sound')?.['value']).toBe('sound.on');
});

it('shows the cleared site after deleting its data', async () => {
  mocks.bridge.browserGetSite.mockResolvedValue({ origin: 'https://example.test', lastVisitedAt: 0, permissions: {}, cookieCount: 3 });
  mocks.bridge.browserGetSystemPermissionStates.mockResolvedValue([]);
  mocks.bridge.browserClearSiteData.mockResolvedValue({ origin: 'https://example.test', lastVisitedAt: 0, permissions: {}, cookieCount: 0 });
  const state = mount(reactive({ url: 'https://example.test/path' }));
  state.button.value = { el: { getClientRects: () => [{ width: 1 }] } };
  await state.toggle();

  await state.select('clear');
  expect(mocks.bridge.browserClearSiteData).toHaveBeenCalledWith('https://example.test');
  const items = mocks.registration!.items();
  expect(items.find((item) => item['id'] === 'cookies')).toMatchObject({ label: 'browser.sites.cookies:{"count":0}' });
  expect(items.some((item) => item['id'] === 'error')).toBe(false);
  expect(mocks.menu.refresh).toHaveBeenCalled();
});

it('reports a failed data deletion in the site info menu', async () => {
  mocks.bridge.browserGetSite.mockResolvedValue({ origin: 'https://example.test', lastVisitedAt: 0, permissions: {}, cookieCount: 3 });
  mocks.bridge.browserGetSystemPermissionStates.mockResolvedValue([]);
  mocks.bridge.browserClearSiteData.mockRejectedValue(new Error('failed'));
  const state = mount(reactive({ url: 'https://example.test/path' }));
  const el = { getClientRects: () => [{ width: 1 }] };
  state.button.value = { el };
  await state.toggle();
  mocks.menu.show.mockClear();

  await expect(state.select('clear')).resolves.toBeUndefined();
  expect(mocks.registration!.items()).toContainEqual(expect.objectContaining({ id: 'error', label: 'browser.sites.failed' }));
  expect(mocks.menu.show).toHaveBeenCalledWith(el);
});

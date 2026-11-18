vi.mock('@moonshot-ai/app-components', async () => ({ PanelContextMenu: (await import('../../../../packages/app-components/src/panel/PanelContextMenu.vue')).default, PanelTabLabel: (await import('../../../../packages/app-components/src/panel/PanelTabLabel.vue')).default }));
import { createRenderer, defineComponent, nextTick, reactive, ref, ssrContextKey } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import PanelTabBar from '../../src/renderer/components/panel/PanelTabBar.vue';

vi.mock('@moonshot-ai/app-client/composables', async () => ({ useIsMobile: () => ref(false), usePanelTabDrag: (await import('../../../../packages/app-client/src/composables/usePanelTabDrag')).usePanelTabDrag }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/renderer/composables/useShortcuts', () => ({ resolvedBindingKeys: () => [] }));
vi.mock('../../src/renderer/lib/browserOverlayMenu', () => ({ registerBrowserOverlayMenu: () => ({ open: ref(false), show: vi.fn(), close: vi.fn(), dispose: vi.fn() }) }));
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
afterEach(() => vi.unstubAllGlobals());

it('isolates favicon failures by tab and retries them after a reload', async () => {
  class Image { getAttribute() { return 'https://example.com/icon.ico'; } }
  vi.stubGlobal('HTMLImageElement', Image);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const tabs = [{ id: 'a', type: 'browser', title: 'A', payload: { favicon: 'https://example.com/icon.ico', loading: false } }, { id: 'b', type: 'browser', title: 'B', payload: { favicon: 'https://example.com/icon.ico', loading: false } }];
  const props = reactive({ tabs, activeTabId: 'a', browserStates: {}, visible: true });
  let state: any;
  const app = renderer.createApp(defineComponent(() => {
    state = (PanelTabBar as any).setup(props, { expose() {}, emit() {} });
    return () => null;
  }));
  app.provide(ssrContextKey, {});
  app.mount({});
  state.onFaviconError('a', { currentTarget: new Image() });
  expect(state.visibleFaviconOf(props.tabs[0])).toBeNull();
  expect(state.visibleFaviconOf(props.tabs[1])).toBe('https://example.com/icon.ico');
  props.tabs[0]!.payload.loading = true;
  await nextTick();
  props.tabs[0]!.payload.loading = false;
  await nextTick();
  expect(state.visibleFaviconOf(props.tabs[0])).toBe('https://example.com/icon.ico');
  app.unmount();
});

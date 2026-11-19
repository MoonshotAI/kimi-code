// @vitest-environment jsdom
vi.mock('@moonshot-ai/app-components', async () => ({ PanelContextMenu: (await import('../../../../packages/app-components/src/panel/PanelContextMenu.vue')).default, PanelTabLabel: (await import('../../../../packages/app-components/src/panel/PanelTabLabel.vue')).default }));
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import PanelTabBar from '../../src/renderer/components/panel/PanelTabBar.vue';

vi.mock('../../src/renderer/composables/useShortcuts', () => ({ resolvedBindingKeys: () => [] }));
vi.mock('../../src/renderer/lib/browserOverlayMenu', () => ({ registerBrowserOverlayMenu: () => ({ available: false, dispose() {}, close() {} }) }));
vi.mock('@moonshot-ai/app-ui', () => {
  const passthrough = defineComponent({ setup: (_, { slots, attrs }) => () => h('span', attrs, slots.default?.()) });
  return { Icon: passthrough, IconButton: passthrough, Kbd: passthrough, Menu: passthrough, MenuItem: passthrough, Spinner: passthrough, Tooltip: passthrough };
});

let app: App | null = null;
let host: HTMLElement;
const scrollIntoView = vi.fn(function (this: Element) { return this; });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  scrollIntoView.mockClear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

function browserTab(id: string) {
  return { id, type: 'browser' as const, title: id, payload: { browserId: `page-${id}` } };
}

async function mountTabBar() {
  const activated = vi.fn();
  const props = reactive({
    tabs: [browserTab('source'), browserTab('other')],
    activeTabId: 'source',
    revealedTabId: null as string | null,
  });
  app = createApp({
    render: () => h(PanelTabBar, {
      ...props, expanded: false, visible: true, canExpand: false, canOpenDiff: false, canOpenFiles: false, canOpenTerm: false,
      canOpenBrowser: true, canForkBrowser: false, browserStates: {}, canOpenBtw: false, onActivate: activated,
    }),
  });
  app.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } }));
  app.mount(host);
  await nextTick();
  scrollIntoView.mockClear();
  return { props, activated };
}

function tabElement(id: string): HTMLElement {
  return host.querySelector<HTMLElement>(`.ptb-tab[data-panel-tab-id="${id}"]`)!;
}

async function openInBackground(props: { tabs: ReturnType<typeof browserTab>[]; revealedTabId: string | null }, id: string): Promise<void> {
  props.tabs = [props.tabs[0]!, browserTab(id), ...props.tabs.slice(1)];
  props.revealedTabId = id;
  await nextTick();
  await nextTick();
}

it('scrolls a background link tab into view and plays its enter animation without selecting it', async () => {
  const { props, activated } = await mountTabBar();
  const focused = document.activeElement;
  await openInBackground(props, 'first');
  expect(scrollIntoView).toHaveBeenCalledOnce();
  expect(scrollIntoView.mock.contexts[0]).toBe(tabElement('first'));
  expect(scrollIntoView).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
  expect(tabElement('first').classList.contains('is-entering')).toBe(true);
  expect(tabElement('source').classList.contains('on')).toBe(true);
  expect(tabElement('first').classList.contains('on')).toBe(false);
  expect(activated).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(focused);
  tabElement('first').dispatchEvent(Object.assign(new Event('animationend'), { pseudoElement: '' }));
  await nextTick();
  expect(tabElement('first').classList.contains('is-entering')).toBe(false);
});

it('reveals each of several quick background link tabs in turn', async () => {
  const { props } = await mountTabBar();
  await openInBackground(props, 'first');
  await openInBackground(props, 'second');
  expect(scrollIntoView.mock.contexts).toEqual([tabElement('first'), tabElement('second')]);
  expect(tabElement('second').classList.contains('is-entering')).toBe(true);
});

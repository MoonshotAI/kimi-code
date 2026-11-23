// @vitest-environment jsdom
vi.mock('@moonshot-ai/app-components', async () => ({ PanelContextMenu: (await import('../../../../packages/app-components/src/panel/PanelContextMenu.vue')).default, PanelTabLabel: (await import('../../../../packages/app-components/src/panel/PanelTabLabel.vue')).default }));
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import PanelTabBar from '../../src/renderer/components/panel/PanelTabBar.vue';

vi.mock('../../src/renderer/composables/useShortcuts', () => ({ resolvedBindingKeys: () => [] }));
vi.mock('../../src/renderer/lib/browserOverlayMenu', () => ({ registerBrowserOverlayMenu: () => ({ available: false, dispose() {}, close() {} }) }));
vi.mock('../../src/renderer/composables/useNativeTerminal', () => ({
  useNativeTerminal: () => ({
    tabs: ref([{ id: 'bottom-1' }, { id: 'bottom-2' }]),
    panelTabOf: (id: string) => (id === 'pty-1' ? { id } : undefined),
  }),
}));
vi.mock('@moonshot-ai/app-ui', () => {
  const passthrough = defineComponent({ setup: (_, { slots, attrs }) => () => h('span', attrs, slots.default?.()) });
  return { Icon: passthrough, IconButton: passthrough, Kbd: passthrough, Menu: passthrough, MenuItem: passthrough, Spinner: passthrough, Tooltip: passthrough };
});

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
});

it('offers moving terminal tabs to the bottom panel and hides the item for other tabs', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const moveToBottom = vi.fn();
  app = createApp({
    render: () => h(PanelTabBar, {
      tabs: [
        { id: 'term', type: 'term', title: 'zsh', payload: { ptyId: 'pty-1' } },
        { id: 'diff', type: 'diff', title: 'Diff' },
      ],
      activeTabId: 'term', expanded: false, visible: true, canExpand: false, canOpenDiff: false, canOpenFiles: false,
      canOpenTerm: false, canOpenBrowser: false, canForkBrowser: false, browserStates: {}, canOpenBtw: false,
      onMoveToBottom: moveToBottom,
    }),
  });
  app.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } }));
  app.mount(host);
  await nextTick();
  const menuLabels = () => [...document.querySelectorAll('.panel-context-menu > span')].map(item => item.textContent);
  const rightClick = async (id: string) => {
    host.querySelector(`.ptb-tab[data-panel-tab-id="${id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await nextTick();
    await nextTick();
  };

  await rightClick('diff');
  expect(menuLabels()).not.toContain('terminal.moveToBottomPanel');

  await rightClick('term');
  expect(menuLabels()).toContain('terminal.moveToBottomPanel');
  [...document.querySelectorAll<HTMLElement>('.panel-context-menu > span')].find(item => item.textContent === 'terminal.moveToBottomPanel')!.click();
  expect(moveToBottom).toHaveBeenCalledWith('term', 2);
});

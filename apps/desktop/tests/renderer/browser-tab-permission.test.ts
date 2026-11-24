vi.mock('@moonshot-ai/app-components', async () => ({ PanelContextMenu: (await import('../../../../packages/app-components/src/panel/PanelContextMenu.vue')).default, PanelTabLabel: (await import('../../../../packages/app-components/src/panel/PanelTabLabel.vue')).default }));
import { afterEach, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createI18n } from 'vue-i18n';
import PanelTabBar from '../../src/renderer/components/panel/PanelTabBar.vue';
import { browserPermissionRequests } from '../../src/renderer/lib/browserPermissions';
import { browserPageDialogs } from '../../src/renderer/lib/browserPageDialogs';

vi.mock('../../src/renderer/composables/useShortcuts', () => ({ resolvedBindingKeys: () => [] }));
vi.mock('../../src/renderer/lib/browserOverlayMenu', () => ({ registerBrowserOverlayMenu: () => ({ available: false, dispose() {}, close() {} }) }));
vi.mock('@moonshot-ai/app-ui', () => {
  const passthrough = defineComponent({ setup: (_, { slots, attrs }) => () => h('span', attrs, slots.default?.()) });
  return { Icon: passthrough, IconButton: passthrough, Kbd: passthrough, Menu: passthrough, MenuItem: passthrough, Spinner: passthrough, Tooltip: passthrough };
});
afterEach(() => { browserPermissionRequests.value = []; browserPageDialogs.value = []; });

it('marks only the requesting tab until its final request ends without changing selection', async () => {
  const activated = vi.fn();
  const render = async () => {
    const app = createSSRApp(PanelTabBar, {
      tabs: [
        { id: 'reading', type: 'browser', title: 'Reading', payload: { browserId: 'page-a' } },
        { id: 'waiting', type: 'browser', title: 'Maps', payload: { browserId: 'page-b' } },
      ],
      activeTabId: 'reading', expanded: false, visible: true, canExpand: false,
      canOpenDiff: false, canOpenTerm: false, canOpenBrowser: true, canForkBrowser: false,
      browserStates: {}, canOpenBtw: false, onActivate: activated,
    });
    app.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: { browser: { permissionPending: 'Waiting for website permission' } } } }));
    return renderToString(app);
  };
  const first = { requestId: 'one', browserId: 'page-b', origin: 'https://example.com', permissions: ['location' as const] };
  browserPermissionRequests.value = [first, { ...first, requestId: 'two' }];
  const pending = await render();
  expect(pending.match(/class="[^"]*\bawaiting-permission\b[^"]*"/g)).toHaveLength(1);
  expect(pending).toContain('aria-label="Maps — Waiting for website permission"');
  expect(pending).toMatch(/data-tab-id="reading"[^>]*aria-selected="true"/);
  expect(pending).toMatch(/data-tab-id="waiting"[^>]*aria-selected="false"/);
  expect(activated).not.toHaveBeenCalled();
  browserPermissionRequests.value = [first];
  expect(await render()).toContain('awaiting-permission');
  browserPermissionRequests.value = [];
  const settled = await render();
  expect(settled).not.toContain('awaiting-permission');
  expect(settled).toContain('aria-label="Maps"');
});

it('marks a background tab with a pending agent upload approval', async () => {
  const app = () => {
    const instance = createSSRApp(PanelTabBar, {
      tabs: [
        { id: 'reading', type: 'browser', title: 'Reading', payload: { browserId: 'page-a' } },
        { id: 'waiting', type: 'browser', title: 'Upload', payload: { browserId: 'page-b' } },
      ],
      activeTabId: 'reading', expanded: false, visible: true, canExpand: false,
      canOpenDiff: false, canOpenTerm: false, canOpenBrowser: true, canForkBrowser: false,
      browserStates: {}, canOpenBtw: false,
    });
    instance.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: { browser: { permissionPending: 'Waiting for website permission' } } } }));
    return renderToString(instance);
  };
  browserPageDialogs.value = [{ dialogId: 'alert', browserId: 'page-a', kind: 'alert', origin: 'https://a.example', message: 'hi', answerer: 'agent' }];
  expect(await app()).not.toContain('awaiting-permission');
  browserPageDialogs.value = [{ dialogId: 'upload', browserId: 'page-b', kind: 'upload', origin: 'https://b.example', message: '', files: ['/tmp/a.txt'], answerer: 'user' }];
  const pending = await app();
  expect(pending.match(/class="[^"]*\bawaiting-permission\b[^"]*"/g)).toHaveLength(1);
  expect(pending).toContain('aria-label="Upload — Waiting for website permission"');
});

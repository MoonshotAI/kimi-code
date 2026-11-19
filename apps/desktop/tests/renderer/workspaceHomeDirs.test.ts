// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import { createApp, h, nextTick, type App } from 'vue';
import workspace from '../../../../packages/app-i18n/src/locales/zh/workspace';
import desktopWorkspaceHome from '../../src/renderer/components/chat/WorkspaceHome.vue';

vi.mock('../../src/renderer/composables/useNativeTerminal', () => ({
  useNativeTerminal: () => ({ available: false, open: { value: false }, toggle: vi.fn() }),
}));
vi.mock('@moonshot-ai/app-components', () => ({
  OpenInMenu: { render: () => null },
}));

let app: App | undefined;
let host: HTMLDivElement | undefined;

function mount(component: unknown, props: Record<string, unknown>): HTMLElement {
  const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: { workspace } } });
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(component as never, props) });
  app.use(i18n);
  app.mount(host);
  return host;
}

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe.each([['desktop', desktopWorkspaceHome]])('%s WorkspaceHome directories', (_platform, component) => {
  it('lists every directory and badges only the first one as primary', async () => {
    const el = mount(component, {
      workspaceName: 'Project',
      workspaceRoot: '/work/a',
      workspaceDirs: ['/work/a', '/work/b', '/work/c'],
    });
    await nextTick();
    const rows = [...el.querySelectorAll('.ws-home-dir')];
    expect(rows.map((row) => row.querySelector('.ws-home-path')?.textContent)).toEqual(['/work/a', '/work/b', '/work/c']);
    expect(rows[0]?.querySelector('.ws-home-primary')).not.toBeNull();
    expect(rows[1]?.querySelector('.ws-home-primary')).toBeNull();
    expect(rows[2]?.querySelector('.ws-home-primary')).toBeNull();
    expect(el.querySelectorAll('.ui-badge')).toHaveLength(1);
  });

  it('shows a single directory without the primary badge', async () => {
    const el = mount(component, { workspaceName: 'Downloads', workspaceRoot: '/Users/me/Downloads' });
    await nextTick();
    expect(el.querySelectorAll('.ws-home-dir')).toHaveLength(1);
    expect(el.querySelector('.ws-home-path')?.textContent).toBe('/Users/me/Downloads');
    expect(el.querySelector('.ui-badge')).toBeNull();
  });

  it('renders no directory list without a root', async () => {
    const el = mount(component, { workspaceName: 'Empty' });
    await nextTick();
    expect(el.querySelector('.ws-home-dirs')).toBeNull();
  });
});

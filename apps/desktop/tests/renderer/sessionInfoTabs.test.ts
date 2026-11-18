// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { PanelTab } from '@moonshot-ai/app-client/composables';

import SessionInfoTabs from '../../src/renderer/components/chat/SessionInfoTabs.vue';
import type { PanelLauncherItem } from '../../src/renderer/lib/panelLauncher';

let app: App | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

function tabs(count: number): PanelTab[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `tab-${index + 1}`,
    type: 'file',
    title: `File ${index + 1}.vue`,
  }));
}

function mount(props: Record<string, unknown>): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(SessionInfoTabs, props);
  app.use(createKimiI18n({ locale: 'zh' }));
  app.mount(host);
  return host;
}

describe('SessionInfoTabs', () => {
  it('preserves tab order, limits the list to five and opens the right panel for overflow', async () => {
    const showTabs = vi.fn();
    const el = mount({ tabs: tabs(7), available: [], onShowTabs: showTabs });
    await nextTick();

    expect(el.textContent).toContain('已打开标签页');
    expect(el.querySelector('.sit-count')).toBeNull();
    expect(el.querySelector('.sit-more')?.textContent).toBe('查看更多（7+）');
    expect(el.querySelector('.sit-more .kw-icon')).toBeNull();
    expect([...el.querySelectorAll('.sit-opened')].map(button => button.textContent)).toEqual([
      'File 1.vue', 'File 2.vue', 'File 3.vue', 'File 4.vue', 'File 5.vue',
    ]);
    expect(el.textContent).not.toContain('File 6.vue');

    el.querySelector<HTMLButtonElement>('.sit-more')!.click();
    await nextTick();
    expect(showTabs).toHaveBeenCalledOnce();
    expect(el.querySelectorAll('.sit-opened')).toHaveLength(5);
    expect(el.textContent).not.toContain('File 6.vue');
  });

  it('omits overflow controls at five tabs and emits available tab actions', async () => {
    const open = vi.fn();
    const available: PanelLauncherItem[] = [
      { type: 'diff', icon: 'file-diff', label: '改动', keys: [], disabled: false },
      { type: 'browser', icon: 'browser', label: '浏览器', keys: [], disabled: false },
      { type: 'term', icon: 'terminal', label: '终端', keys: [], disabled: true },
      { type: 'inspector', icon: 'inspector', label: '调试面板', keys: [], disabled: false },
    ];
    const el = mount({ tabs: tabs(5), available, onOpen: open });
    await nextTick();

    expect(el.querySelector('.sit-count')).toBeNull();
    expect(el.querySelector('.sit-more')).toBeNull();
    expect(el.textContent).toContain('可打开');
    expect(el.textContent).not.toContain('改动');
    expect(el.textContent).not.toContain('调试面板');
    const buttons = el.querySelectorAll<HTMLButtonElement>('.sit-available');
    expect(buttons).toHaveLength(2);
    expect(buttons[1]!.disabled).toBe(true);
    buttons[0]!.click();
    buttons[1]!.click();
    expect(open).toHaveBeenCalledExactlyOnceWith('browser');
  });
});

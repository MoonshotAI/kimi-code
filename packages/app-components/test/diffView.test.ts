// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

import DiffView from '../src/chat/DiffView.vue';
import diffViewSource from '../src/chat/DiffView.vue?raw';

let app: App | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe('DiffView workspace roots', () => {
  it('selects a different root from the panel header', async () => {
    const selectRoot = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(DiffView, {
      changes: [],
      gitInfo: { branch: 'main', ahead: 0, behind: 0 },
      roots: ['/a', '/b'],
      cwd: '/b',
      onSelectRoot: selectRoot,
    });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await nextTick();

    expect(host.querySelector('.files-root-select-name')?.textContent).toBe('b');
    host.querySelector<HTMLButtonElement>('.files-root-select')!.click();
    await nextTick();
    const options = document.body.querySelectorAll<HTMLButtonElement>('.files-root-menu-name');
    expect([...options].map(option => option.textContent)).toEqual(['a', 'b']);
    options[0]!.click();
    expect(selectRoot).toHaveBeenCalledExactlyOnceWith('/a');
  });

  it('removes the root select wrapper padding on the component root', () => {
    const rootStyle = diffViewSource.match(/\.dv-root-select\s*\{([^}]*)\}/)?.[1];

    expect(rootStyle).toContain('padding: 0');
    expect(diffViewSource).not.toContain('.dv-root-select :deep(.files-root-select-wrap)');
  });
});

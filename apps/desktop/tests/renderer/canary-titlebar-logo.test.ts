// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, type App } from 'vue';

const mocks = vi.hoisted(() => ({ isCanaryBuild: { value: false } }));

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@moonshot-ai/app-client/composables', () => ({
  useCanaryChannel: () => ({ isCanaryBuild: mocks.isCanaryBuild }),
}));
vi.mock('@moonshot-ai/app-ui', () => ({
  Icon: { template: '<span />' },
  IconButton: { template: '<button><slot /></button>' },
}));
vi.mock('../../src/renderer/composables/useShortcuts', () => ({
  shortcutTooltip: (label: string) => ({ text: label, keys: [] }),
}));
vi.mock('../../src/renderer/components/UpdateIndicator.vue', () => ({
  default: { template: '<span />' },
}));

import CustomTitleBar from '../../src/renderer/components/window/CustomTitleBar.vue';

let app: App | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe('Windows title bar logo', () => {
  it.each([
    [
      false,
      { gradient: ['#117DFB', '#449BFF', '#77B6FF'], head: '#2389FF', dash: '#007CFF', dot: '#1783FF' },
    ],
    [
      true,
      { gradient: ['#F0A500', '#FFC61A', '#FFD964'], head: '#FFC61A', dash: '#FFC61A', dot: '#F0A500' },
    ],
  ])('uses the expected palette when isCanaryBuild is %s', (isCanaryBuild, palette) => {
    mocks.isCanaryBuild.value = isCanaryBuild;
    host = document.createElement('div');
    document.body.append(host);
    app = createApp({
      render: () => h(CustomTitleBar, { sidebarCollapsed: false, fullscreen: false }),
    });
    app.mount(host);

    const stops = [...host.querySelectorAll('.brand-logo radialGradient stop')].map((stop) =>
      stop.getAttribute('stop-color'),
    );
    const paths = host.querySelectorAll('.brand-logo > path');
    expect(stops).toEqual(palette.gradient);
    expect(paths[0]?.getAttribute('fill')).toBe(palette.head);
    expect(paths[3]?.getAttribute('stroke')).toBe(palette.dash);
    expect(paths[4]?.getAttribute('fill')).toBe(palette.dot);
  });
});

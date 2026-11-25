// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';

const mocks = vi.hoisted(() => ({
  enabled: { value: true },
  isRealCanaryBuild: { value: true },
  importStableSettings: vi.fn(),
  check: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key}:${JSON.stringify(params)}`,
  }),
}));

vi.mock('@moonshot-ai/app-client/composables', () => ({
  useCanaryChannel: () => ({
    enabled: mocks.enabled,
    isRealCanaryBuild: mocks.isRealCanaryBuild,
    importStableSettings: mocks.importStableSettings,
  }),
  useUpdateStatus: () => ({ check: mocks.check }),
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@moonshot-ai/app-ui', () => {
  const passthrough = defineComponent({ setup: (_, { slots, attrs }) => () => h('div', attrs, slots.default?.()) });
  return {
    Icon: passthrough,
    Menu: passthrough,
    MenuItem: passthrough,
    Spinner: passthrough,
    Tooltip: passthrough,
  };
});

import DebugMenu from '../../src/renderer/components/DebugMenu.vue';

let app: App | undefined;
let host: HTMLDivElement | undefined;
let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  mocks.enabled.value = true;
  mocks.isRealCanaryBuild.value = true;
  vi.stubGlobal('__KIMI_CLIENT_VERSION__', '1.5.0-canary.20261125111403-132c4e8');
  vi.stubGlobal('__KIMI_COMMIT_SHA__', '132c4e88b1d316a7d9a9b2f20df4d59a88061dc7');
  vi.stubGlobal('__KIMI_BUILD_TIME__', '2026-11-25T11:39:39.000Z');
  vi.stubGlobal('__KIMI_BRANCH__', 'main');
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountMenu(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(DebugMenu) });
  app.mount(host);
  await nextTick();
  host.querySelector<HTMLButtonElement>('.dbg-pill')?.click();
  await nextTick();
}

describe('DebugMenu', () => {
  it('opens the build commit on MoonshotAI/kimi-code', async () => {
    await mountMenu();
    const build = document.body.querySelector<HTMLButtonElement>('.dbg-build');
    expect(build).not.toBeNull();
    expect(build?.disabled).toBe(false);
    expect(build?.textContent).toContain('settings.canaryTargetVersion:{"version":"1.5.0"}');
    expect(build?.textContent).toContain('v1.5.0-canary.20261125111403-132c4e8 · 132c4e88');
    build?.click();
    expect(openSpy).toHaveBeenCalledExactlyOnceWith(
      'https://github.com/MoonshotAI/kimi-code/commit/132c4e88b1d316a7d9a9b2f20df4d59a88061dc7',
      '_blank',
      'noopener',
    );
  });

  it('disables the commit link when no commit sha is available', async () => {
    vi.stubGlobal('__KIMI_COMMIT_SHA__', '');
    await mountMenu();
    const build = document.body.querySelector<HTMLButtonElement>('.dbg-build');
    expect(build?.disabled).toBe(true);
    build?.click();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

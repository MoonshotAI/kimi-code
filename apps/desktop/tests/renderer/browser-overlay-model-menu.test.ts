// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { AppModel } from '@moonshot-ai/app-core/api';
import type { BrowserOverlayConfig, BrowserOverlayShown } from '../../src/shared/browser-overlay';

const modelMenuProps: { hostFrame?: { x: number; y: number; viewportWidth: number; viewportHeight: number } }[] = [];

vi.mock('@moonshot-ai/app-components', async () => {
  const { ref } = await import('vue');
  return {
    ModelQuickMenu: defineComponent({
      props: ['hostFrame'],
      setup(props, { expose }) {
        const el = ref<HTMLElement>();
        expose({ el });
        modelMenuProps.push(props as (typeof modelMenuProps)[number]);
        return () => h('div', { ref: el, class: 'mqm-stub' });
      },
    }),
  };
});

const models: AppModel[] = [
  { id: 'kimi/k2.5', provider: 'managed:kimi-code', model: 'k2.5', displayName: 'Kimi K2.5', maxContextSize: 262144, supportEfforts: ['low', 'high'] },
  { id: 'openrouter/gpt', provider: 'openrouter', model: 'gpt', displayName: 'GPT-5.1', maxContextSize: 400 * 1024 },
];

function menuConfig(providerModels: AppModel[], activeProvider = 'managed:kimi-code'): BrowserOverlayConfig {
  return {
    kind: 'menu',
    requestId: 1,
    menuId: 'composer-models',
    anchor: { x: 700, y: 840, width: 140, height: 32 },
    placement: 'top-end',
    offset: 8,
    width: 240,
    maxHeight: 480,
    items: [],
    modelMenu: {
      models,
      recentModels: [models[0]!],
      providerModels,
      providers: [
        { id: 'managed:kimi-code', label: 'Kimi Subscription' },
        { id: 'openrouter', label: 'openrouter' },
      ],
      activeProvider,
      activeProviderLabel: activeProvider,
      currentModelId: models[0]!.id,
      currentEffort: 'high',
    },
  };
}

describe('browser overlay model menu anchoring', () => {
  let app: App | undefined;
  let host: HTMLDivElement | undefined;
  let emitConfig: (config: BrowserOverlayConfig) => void;
  let emitShown: (payload: BrowserOverlayShown) => void;
  const rendered = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener(): void {},
      removeEventListener(): void {},
    }));
    rendered.mockReset();
    Object.assign(window, {
      kimiBrowserOverlay: {
        ready: vi.fn(),
        rendered,
        hidden: vi.fn(),
        activate: vi.fn(),
        submitForm: vi.fn(),
        dismiss: vi.fn(),
        onConfig: (cb: typeof emitConfig) => { emitConfig = cb; return () => {}; },
        onShown: (cb: typeof emitShown) => { emitShown = cb; return () => {}; },
        onHide: () => () => {},
      },
    });
  });

  afterEach(() => {
    app?.unmount();
    app = undefined;
    host?.remove();
    host = undefined;
    delete (window as { kimiBrowserOverlay?: unknown }).kimiBrowserOverlay;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('anchors the model menu by its bottom inset and refreshes hostFrame from live layout before the next shown IPC', async () => {
    const { IconResolverKey } = await import('@moonshot-ai/app-ui');
    const { default: BrowserOverlayMenu } = await import('../../src/renderer/components/browser-overlay/BrowserOverlayMenu.vue');
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(BrowserOverlayMenu);
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(IconResolverKey, (name) => defineComponent({ setup: () => () => h('svg', { 'data-icon': name }) }));
    app.mount(host);

    emitConfig(menuConfig([models[0]!]));
    await nextTick();
    const menu = host.querySelector<HTMLElement>('.browser-overlay-model-menu')!;
    let offsetTop = 278;
    let offsetHeight = 474;
    Object.defineProperties(menu, {
      offsetLeft: { configurable: true, value: 256 },
      offsetTop: { configurable: true, get: () => offsetTop },
      offsetWidth: { configurable: true, value: 240 },
      offsetHeight: { configurable: true, get: () => offsetHeight },
    });
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => ({
      width: el === menu ? '240px' : '0px',
      height: el === menu ? `${offsetHeight}px` : '0px',
    }) as CSSStyleDeclaration);

    emitShown({
      requestId: 1,
      placement: 'top-end',
      menuOffset: { x: 256, y: 278 },
      menuBottom: 68,
      menuFrame: { x: 600, y: 358, viewportWidth: 1440, viewportHeight: 900 },
    });
    await nextTick();
    expect(menu.style.bottom).toBe('68px');
    expect(menu.style.top).toBe('auto');
    expect(modelMenuProps[0]?.hostFrame?.y).toBe(358);

    offsetTop = 406;
    offsetHeight = 346;
    emitConfig(menuConfig([models[1]!], 'openrouter'));
    await nextTick();
    await nextTick();

    expect(menu.style.bottom).toBe('68px');
    expect(modelMenuProps[0]?.hostFrame?.y).toBe(486);
    expect(rendered).toHaveBeenLastCalledWith({ requestId: 1, width: 240, height: 346 });

    offsetTop = 438;
    offsetHeight = 314;
    emitConfig(menuConfig([models[0]!, models[1]!], 'managed:kimi-code'));
    await nextTick();
    await nextTick();

    expect(menu.style.bottom).toBe('68px');
    expect(modelMenuProps[0]?.hostFrame?.y).toBe(518);
    expect(rendered).toHaveBeenLastCalledWith({ requestId: 1, width: 240, height: 314 });
  });
});

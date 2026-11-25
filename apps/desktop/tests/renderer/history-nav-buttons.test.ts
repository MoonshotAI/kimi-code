// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import HistoryNavButtons from '../../src/renderer/components/window/HistoryNavButtons.vue';

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/renderer/composables/useShortcuts', () => ({
  shortcutTooltip: (text: string, id: string) => ({ text, keys: [id] }),
}));
vi.mock('@moonshot-ai/app-ui', async () => {
  const { defineComponent, h: render } = await import('vue');
  return {
    Icon: defineComponent({ props: ['name'], setup: () => () => null }),
    IconButton: defineComponent({
      props: ['label', 'tooltip', 'keys', 'disabled', 'size'],
      emits: ['click'],
      setup: (props, { emit, slots }) => () =>
        render('button', { 'aria-label': props.label, disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()),
    }),
  };
});

class FakeNavigation extends EventTarget {
  canGoBack = false;
  canGoForward = false;
}

let navigation: FakeNavigation;
let app: App | null = null;
let navigated: string[];

beforeEach(() => {
  navigation = new FakeNavigation();
  Object.defineProperty(window, 'navigation', { value: navigation, configurable: true });
  navigated = [];
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.replaceChildren();
});

function mount(): { back: HTMLButtonElement; forward: HTMLButtonElement } {
  const host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(HistoryNavButtons, { onNavigate: (direction: string) => navigated.push(direction) }) });
  app.mount(host);
  const [back, forward] = host.querySelectorAll('button');
  return { back: back!, forward: forward! };
}

it('follows the window history and disables directions that have nowhere to go', async () => {
  const { back, forward } = mount();
  expect(back.getAttribute('aria-label')).toBe('shortcuts.actions.navigateBack.label');
  expect(forward.getAttribute('aria-label')).toBe('shortcuts.actions.navigateForward.label');
  expect([back.disabled, forward.disabled]).toEqual([true, true]);

  navigation.canGoBack = true;
  navigation.dispatchEvent(new Event('currententrychange'));
  await nextTick();
  expect([back.disabled, forward.disabled]).toEqual([false, true]);

  back.click();
  forward.click();
  expect(navigated).toEqual(['back']);

  navigation.canGoForward = true;
  navigation.dispatchEvent(new Event('currententrychange'));
  await nextTick();
  forward.click();
  expect(navigated).toEqual(['back', 'forward']);
});

it('stops listening to history changes once unmounted', () => {
  const removeEventListener = vi.spyOn(navigation, 'removeEventListener');
  mount();
  app?.unmount();
  app = null;
  expect(removeEventListener).toHaveBeenCalledWith('currententrychange', expect.any(Function));
});

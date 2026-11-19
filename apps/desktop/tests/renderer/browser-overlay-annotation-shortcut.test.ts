// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

vi.mock('../../src/renderer/components/browser-overlay/AnnotationDetails.vue', () => ({
  default: defineComponent({ setup: () => () => h('div') }),
}));
vi.mock('../../src/renderer/components/browser-overlay/AnnotationScroll.vue', () => ({
  default: defineComponent({ setup: (_props, { slots }) => () => h('div', slots.default?.()) }),
}));

let app: App | undefined;
let host: HTMLDivElement | undefined;
const submitForm = vi.fn();

async function mountAnnotationDialog(platform: string): Promise<HTMLElement> {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  let pushConfig: (config: unknown) => void = () => {};
  Object.assign(window, {
    kimiBrowserOverlay: {
      ready: vi.fn(),
      rendered: vi.fn(),
      hidden: vi.fn(),
      activate: vi.fn(),
      submitForm,
      dismiss: vi.fn(),
      onConfig: (cb: (config: unknown) => void) => {
        pushConfig = cb;
        return () => {};
      },
      onShown: () => () => {},
      onHide: () => () => {},
    },
  });
  const { IconResolverKey } = await import('@moonshot-ai/app-ui');
  const { default: BrowserOverlayMenu } = await import('../../src/renderer/components/browser-overlay/BrowserOverlayMenu.vue');
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(BrowserOverlayMenu);
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name) => defineComponent({ setup: () => () => h('svg', { class: 'stub-icon', 'data-icon': name }) }));
  app.mount(host);
  pushConfig({
    kind: 'dialog',
    requestId: 1,
    title: 'Annotation',
    confirmLabel: 'Add',
    cancelLabel: 'Cancel',
    annotation: { capture: { id: 'a1', ordinal: 1, target: { kind: 'region' } }, labels: { annotation: 'Annotation' } },
    input: { label: 'Comment', value: '' },
  });
  await nextTick();
  await nextTick();
  return host;
}

function confirmKeys(root: HTMLElement): (string | null | undefined)[] {
  return [...root.querySelectorAll('.browser-overlay-dialog__confirm .ui-kbd__key')].map((key) =>
    key.querySelector('svg') === null ? key.textContent : key.querySelector('svg')?.getAttribute('data-icon'),
  );
}

function pressEnter(root: HTMLElement, init: KeyboardEventInit): void {
  root.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }));
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  submitForm.mockReset();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser annotation confirm shortcut', () => {
  it('shows Command and Enter on Apple platforms and confirms with Command+Enter', async () => {
    const root = await mountAnnotationDialog('MacIntel');
    expect(confirmKeys(root)).toEqual(['key-command', 'key-enter']);
    pressEnter(root, { ctrlKey: true });
    expect(submitForm).not.toHaveBeenCalled();
    pressEnter(root, { metaKey: true });
    expect(submitForm).toHaveBeenCalledWith(expect.objectContaining({ requestId: 1, action: 'confirm' }));
  });

  it('shows Ctrl and Enter on other platforms and confirms with Ctrl+Enter', async () => {
    const root = await mountAnnotationDialog('Win32');
    expect(confirmKeys(root)).toEqual(['Ctrl', 'key-enter']);
    pressEnter(root, { metaKey: true });
    expect(submitForm).not.toHaveBeenCalled();
    pressEnter(root, { ctrlKey: true });
    expect(submitForm).toHaveBeenCalledWith(expect.objectContaining({ requestId: 1, action: 'confirm' }));
  });
});

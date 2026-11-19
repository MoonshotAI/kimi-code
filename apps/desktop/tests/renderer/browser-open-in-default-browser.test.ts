// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EMPTY_BROWSER_STATE, type BrowserState } from '../../src/shared/browser';

const native = vi.hoisted(() => ({ bridge: null as unknown }));

vi.mock('vue-i18n', async () => {
  const { ref } = await import('vue');
  return { useI18n: () => ({ t: (key: string) => key, locale: ref('en') }) };
});
vi.mock('@moonshot-ai/app-components', () => ({ useComposerBrowserReferenceHost: () => ({ isPicking: () => false, beginPick: async () => {}, cancelPick: () => {} }) }));
vi.mock('@moonshot-ai/app-client/composables', () => ({ useConfirmDialog: () => ({ confirm: async () => {} }) }));
vi.mock('../../src/renderer/lib/browserPermissions', () => ({ useBrowserPermissionDialog: () => () => {} }));
vi.mock('../../src/renderer/lib/browserPageDialogs', () => ({ useBrowserPageDialog: () => () => {} }));
vi.mock('../../src/renderer/lib/browserOverlayMenu', async () => {
  const { ref } = await import('vue');
  return { registerBrowserOverlayMenu: () => ({ open: ref(false), closing: ref(false), toggle: () => {}, show: () => {}, request: () => {}, close: () => {}, refresh: () => {}, dispose: () => {} }) };
});
vi.mock('../../src/renderer/lib/nativeBrowser', () => ({ getNativeBrowserBridge: () => native.bridge }));

import PanelBrowserTab from '../../src/renderer/components/browser/PanelBrowserTab.vue';

let app: App | null = null;
let host: HTMLDivElement;
let pushState: (state: BrowserState) => void;
let bridge: { browserTabCommand: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  bridge = { browserTabCommand: vi.fn(async () => ({ ...EMPTY_BROWSER_STATE })) };
  const methods = {
    ...bridge,
    getBrowserState: vi.fn(async () => ({ ...EMPTY_BROWSER_STATE })),
    onBrowserState: vi.fn((cb: (browserId: string, state: BrowserState) => void) => {
      pushState = (state) => cb('browser-1', state);
      return () => {};
    }),
    browserSetOccluded: vi.fn(async () => {}),
    browserGetDownloads: vi.fn(async () => []),
    onBrowserDownloads: vi.fn(() => () => {}),
  };
  native.bridge = new Proxy(methods, { get: (target, key) => (key in target ? target[key as keyof typeof target] : vi.fn()) });
  app = createApp(PanelBrowserTab, { browserId: 'browser-1', active: true, occluded: false });
  app.mount(host);
  await nextTick();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

function openButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="browser.openInDefaultBrowser"]');
  if (button === null) throw new Error('missing open in default browser button');
  return button;
}

async function showUrl(url: string): Promise<void> {
  pushState({ ...EMPTY_BROWSER_STATE, url });
  await nextTick();
}

it('sits in the toolbar right before the annotation control', () => {
  const button = openButton();
  expect(button.closest('.pb-toolbar')).not.toBeNull();
  expect(button.nextElementSibling?.getAttribute('aria-label')).toBe('browserReference.title');
});

it('is enabled only for committed http(s) pages', async () => {
  expect(openButton().disabled).toBe(true);
  await showUrl('https://example.com/page');
  expect(openButton().disabled).toBe(false);
  await showUrl('http://localhost:3000/');
  expect(openButton().disabled).toBe(false);
  for (const url of ['', 'file:///Users/me/index.html', 'about:blank', 'data:text/html,hi']) {
    await showUrl(url);
    expect(openButton().disabled).toBe(true);
  }
});

it('asks main to open the tab by id instead of sending the typed address', async () => {
  await showUrl('https://example.com/committed');
  const input = host.querySelector<HTMLInputElement>('.pb-address input');
  if (input === null) throw new Error('missing address input');
  input.dispatchEvent(new FocusEvent('focus'));
  input.value = 'https://half-typed.test';
  input.dispatchEvent(new Event('input'));
  await nextTick();
  openButton().click();
  await nextTick();
  expect(bridge.browserTabCommand).toHaveBeenCalledExactlyOnceWith({ browserId: 'browser-1', action: 'open-external' });
});

it('does nothing when clicked without a web page', async () => {
  await showUrl('file:///Users/me/index.html');
  openButton().click();
  await nextTick();
  expect(bridge.browserTabCommand).not.toHaveBeenCalled();
});

it('shows a failure inline under the address bar', async () => {
  bridge.browserTabCommand.mockRejectedValueOnce(new Error('Browser tab has no web URL'));
  await showUrl('https://example.com/');
  openButton().click();
  await vi.waitFor(() => expect(host.querySelector('.pb-operation-error')?.textContent).toContain('Browser tab has no web URL'));
});

it('clears the previous failure when a retry starts', async () => {
  bridge.browserTabCommand.mockRejectedValueOnce(new Error('Browser tab has no web URL'));
  await showUrl('https://example.com/');
  openButton().click();
  await vi.waitFor(() => expect(host.querySelector('.pb-operation-error')).not.toBeNull());
  openButton().click();
  await vi.waitFor(() => expect(bridge.browserTabCommand).toHaveBeenCalledTimes(2));
  await nextTick();
  expect(host.querySelector('.pb-operation-error')).toBeNull();
});

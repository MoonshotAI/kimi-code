// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import type { BrowserDownloadItem } from '../../src/shared/browser-data';

const mocks = vi.hoisted(() => ({
  push: undefined as ((downloads: BrowserDownloadItem[]) => void) | undefined,
  show: vi.fn(),
  close: vi.fn(),
  open: undefined as unknown as { value: boolean },
  onSelect: undefined as ((itemId: string) => void) | undefined,
}));

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock('../../src/renderer/lib/nativeBrowser', () => ({
  getNativeBrowserBridge: () => ({
    browserGetDownloads: async () => [],
    browserWatchDownloads: () => {},
    browserOpenDownload: async () => true,
    onBrowserDownloads: (cb: (downloads: BrowserDownloadItem[]) => void) => { mocks.push = cb; return () => {}; },
  }),
}));

vi.mock('../../src/renderer/lib/browserOverlayMenu', async () => {
  const { ref: vueRef } = await import('vue');
  return {
    registerBrowserOverlayMenu: (options: { onSelect: (itemId: string) => void }) => {
      mocks.onSelect = options.onSelect;
      const open = vueRef(false);
      mocks.open = open;
      return {
        available: true,
        request: async () => undefined,
        open,
        closing: vueRef(false),
        show: (...args: unknown[]) => { mocks.show(...args); open.value = true; },
        showAt: () => {},
        toggle: () => { open.value = !open.value; },
        refresh: () => {},
        close: () => { mocks.close(); open.value = false; },
        dispose: () => {},
      };
    },
  };
});

import BrowserDownloadButton from '../../src/renderer/components/browser/BrowserDownloadButton.vue';
import { BROWSER_DOWNLOAD_AUTO_CLOSE_MS } from '../../src/renderer/lib/browserDownloads';

const T0 = new Date('2026-01-01T12:00:00Z').getTime();

function item(id: string, patch: Partial<BrowserDownloadItem> = {}): BrowserDownloadItem {
  return { id, url: `https://example.com/${id}`, filename: `${id}.zip`, state: 'progressing', startedAt: T0, receivedBytes: 0, totalBytes: 100, active: true, ...patch };
}

function done(id: string): BrowserDownloadItem {
  return item(id, { state: 'completed', receivedBytes: 100, active: undefined });
}

let app: App;
let host: HTMLDivElement;
const active = ref(true);

async function flush(): Promise<void> {
  for (let n = 0; n < 4; n += 1) await nextTick();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  mocks.show.mockClear();
  mocks.close.mockClear();
  active.value = true;
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(BrowserDownloadButton, { browserId: 'b1', active: active.value }) });
  app.mount(host);
  await flush();
  mocks.push!([item('a'), item('b')]);
  await flush();
});

afterEach(() => {
  app.unmount();
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('download bubble auto-open', () => {
  it('restarts the auto-close timer when another download completes while the bubble is open', async () => {
    mocks.push!([done('a'), item('b')]);
    await flush();
    expect(mocks.show).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(BROWSER_DOWNLOAD_AUTO_CLOSE_MS - 100);
    mocks.push!([done('a'), done('b')]);
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.open.value).toBe(true);
    expect(mocks.show).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(BROWSER_DOWNLOAD_AUTO_CLOSE_MS);
    expect(mocks.open.value).toBe(false);
  });

  it('closes the bubble when its tab becomes inactive', async () => {
    mocks.push!([done('a'), item('b')]);
    await flush();
    expect(mocks.open.value).toBe(true);

    active.value = false;
    await flush();
    expect(mocks.close).toHaveBeenCalled();
    expect(mocks.open.value).toBe(false);
  });

  it('clears the unseen highlight when the user acts on the auto-opened bubble', async () => {
    vi.setSystemTime(T0 + 1_000);
    mocks.push!([done('a'), item('b')]);
    await flush();
    expect(mocks.open.value).toBe(true);
    expect(host.querySelector('.is-unseen')).not.toBeNull();

    mocks.onSelect!('see-all');
    await flush();
    expect(host.querySelector('.is-unseen')).toBeNull();
  });
});

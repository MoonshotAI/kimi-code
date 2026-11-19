// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { warningsStore } from '@moonshot-ai/app-client/stores';
import AppToasts from '../src/AppToasts.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  warningsStore().setWarnings([]);
  vi.unstubAllGlobals();
});

describe('AppToasts copy link', () => {
  it('copies the exact URL and shows the copied label', async () => {
    const url = 'https://example.com/docs?token=secret';
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    warningsStore().setWarnings([{
      severity: 'warning',
      title: "Couldn't open link",
      message: "Couldn't open your browser. Copy the link and open it manually",
      copyLink: { label: 'Copy link', copiedLabel: 'Link copied', url },
    }]);
    app = createApp({ render: () => h(AppToasts) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);

    const button = await vi.waitFor(() => {
      const element = host.querySelector<HTMLButtonElement>('button.ui-toast__link');
      expect(element).not.toBeNull();
      return element as HTMLButtonElement;
    });
    expect(button.textContent).toContain('Copy link');
    button.click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
    await nextTick();
    await vi.waitFor(() => expect(button.textContent).toContain('Link copied'));
  });
});

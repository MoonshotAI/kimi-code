// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { warningsStore } from '@moonshot-ai/app-client/stores';
import { dockHeightPx } from '@moonshot-ai/app-client/lib';
import AppToasts from '../src/AppToasts.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  warningsStore().setWarnings([{ severity: 'info', title: 'note' }]);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  warningsStore().setWarnings([]);
  dockHeightPx.value = null;
});

function mountToasts(): HTMLElement {
  app = createApp({ render: () => h(AppToasts) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  const el = host.querySelector('.app-toasts');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe('AppToasts dock height', () => {
  it('scopes --dock-h to its own element when a dock height is given', () => {
    dockHeightPx.value = 120;
    const el = mountToasts();
    expect(el.getAttribute('style') ?? '').toContain('--dock-h: 120px');
    expect(document.documentElement.style.getPropertyValue('--dock-h')).toBe('');
  });

  it('sets no inline variable when the dock height is unknown', () => {
    dockHeightPx.value = null;
    const el = mountToasts();
    expect(el.getAttribute('style') ?? '').not.toContain('--dock-h');
  });
});

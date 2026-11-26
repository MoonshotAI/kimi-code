import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KimiI18n } from '@moonshot-ai/app-i18n';

const appUse = vi.fn();

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createApp: () => ({ use: appUse, provide: vi.fn(), mount: vi.fn() }),
}));

vi.mock('@moonshot-ai/app-core', () => ({
  useAppearance: () => ({ setColorScheme: vi.fn(), setFontScale: vi.fn() }),
  useFontPrefs: vi.fn(),
}));

vi.mock('../../src/renderer/components/browser-overlay/BrowserOverlayMenu.vue', () => ({ default: {} }));

describe('browser overlay locale sync', () => {
  let storage: Map<string, string>;
  let windowTarget: EventTarget;

  beforeEach(() => {
    vi.resetModules();
    appUse.mockClear();
    storage = new Map([['kimi-locale', 'zh']]);
    const localStorageMock = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => storage.clear(),
    };
    windowTarget = new EventTarget();
    vi.stubGlobal('localStorage', localStorageMock);
    vi.stubGlobal('window', Object.assign(windowTarget, {
      localStorage: localStorageMock,
      location: { search: '', href: 'http://localhost/browser-overlay.html' },
    }));
    vi.stubGlobal('navigator', { language: 'zh-CN' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts with the stored locale and follows kimi-locale storage changes from the main window', async () => {
    await import('../../src/renderer/browser-overlay');
    const i18n = appUse.mock.calls[0]?.[0] as KimiI18n;
    expect(i18n.global.locale.value).toBe('zh');
    expect(i18n.global.t('status.recentModels')).toBe('最近使用');

    storage.set('kimi-locale', 'en');
    windowTarget.dispatchEvent(Object.assign(new Event('storage'), { key: 'kimi-locale', newValue: 'en' }));
    expect(i18n.global.locale.value).toBe('en');
    expect(i18n.global.t('status.recentModels')).toBe('Recently used');
    expect(i18n.global.t('status.switchProvider')).toBe('Provider');

    windowTarget.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated-key', newValue: 'zh' }));
    expect(i18n.global.locale.value).toBe('en');
  });
});

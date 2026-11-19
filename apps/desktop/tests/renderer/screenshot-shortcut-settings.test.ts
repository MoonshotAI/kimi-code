// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import ComposerScreenshotShortcut from '../../../../packages/app-components/src/composer/ComposerScreenshotShortcut.vue';
import ShortcutsPanel from '../../src/renderer/components/settings/ShortcutsPanel.vue';
import { osGlobalFailures } from '../../src/renderer/composables/useShortcuts';
import shortcuts from '../../../../packages/app-i18n/src/locales/zh/shortcuts';

vi.mock('../../src/renderer/lib/track', () => ({ track: vi.fn() }));

let app: App | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  Object.defineProperty(window, 'kimiDesktop', {
    configurable: true,
    value: { isScreenshotSupported: () => true },
  });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
});

function mount(component: App): void {
  app = component;
  app.use(createI18n({
    legacy: false,
    locale: 'zh',
    messages: { zh: { shortcuts, settings: { tabs: { shortcuts: '快捷键' } } } },
  }));
  app.mount(host);
}

describe('screenshot shortcut settings entry', () => {
  it('keeps occupied keys visible and opens configuration when clicked', async () => {
    const configure = vi.fn();
    mount(createApp(ComposerScreenshotShortcut, {
      keys: ['mod', 'shift', 's'], unavailable: true, onConfigure: configure,
    }));
    expect([...host.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(['Ctrl', 'Shift', 'S']);
    const button = host.querySelector<HTMLButtonElement>('button')!;
    expect(button.classList.contains('shortcut-unavailable')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('编辑快捷键');
    button.click();
    await nextTick();
    expect(configure).toHaveBeenCalledOnce();
  });

  it('offers configuration when no shortcut is assigned', () => {
    const configure = vi.fn();
    mount(createApp(ComposerScreenshotShortcut, { keys: [], onConfigure: configure }));
    expect(host.textContent).toContain('未分配');
    host.querySelector<HTMLButtonElement>('button')!.click();
    expect(configure).toHaveBeenCalledOnce();
  });

  it('shows a neutral hint instead of a warning when the build gates the shortcut', async () => {
    const configure = vi.fn();
    mount(createApp(ComposerScreenshotShortcut, {
      keys: ['mod', 'shift', 's'], unavailable: true, failureReason: 'channel-disabled', onConfigure: configure,
    }));
    const button = host.querySelector<HTMLButtonElement>('button')!;
    expect(button.classList.contains('shortcut-unavailable')).toBe(false);
    expect([...host.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(['Ctrl', 'Shift', 'S']);
    button.click();
    await nextTick();
    expect(configure).toHaveBeenCalledOnce();
  });

  it('opens the shortcut panel at the screenshot setting and lets users clear the filter', async () => {
    mount(createApp(ShortcutsPanel, { initialAction: 'captureScreenshot' }));
    expect(host.querySelectorAll('.sc-row')).toHaveLength(1);
    expect(host.querySelector('.sc-row')?.textContent).toContain('截屏');
    const search = host.querySelector<HTMLInputElement>('.sc-search input')!;
    expect(search.value).toBe('截屏');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(host.querySelectorAll('.sc-row').length).toBeGreaterThan(1);
  });

  it('shows the inline error from the failure state and clears it when registration recovers', async () => {
    mount(createApp(ShortcutsPanel, { initialAction: 'captureScreenshot' }));
    osGlobalFailures.captureScreenshot = 'conflicted';
    await nextTick();
    expect(host.querySelector('.sc-row')?.textContent).toContain(shortcuts.globalTaken);
    osGlobalFailures.captureScreenshot = 'channel-disabled';
    await nextTick();
    expect(host.querySelector('.sc-row')?.textContent).toContain(shortcuts.channelDisabled);
    delete osGlobalFailures.captureScreenshot;
    await nextTick();
    expect(host.querySelector('.sc-row')?.textContent).not.toContain(shortcuts.globalTaken);
    expect(host.querySelector('.sc-row')?.textContent).not.toContain(shortcuts.channelDisabled);
  });
});

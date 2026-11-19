// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import { createApp, nextTick, type App } from 'vue';
import shortcuts from '../../../../packages/app-i18n/src/locales/zh/shortcuts';
import type { GlobalShortcutResult } from '../../src/shared/global-shortcut';

vi.mock('../../src/renderer/lib/track', () => ({ track: vi.fn() }));

let app: App | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  host?.remove();
  vi.unstubAllGlobals();
});

describe('screenshot shortcut recording', () => {
  it.each([false, true])('keeps rejected bindings with a delayed summon response (customized=%s)', async (customized) => {
    vi.resetModules();
    const pending = new Map<string, string | null>();
    let releaseSummon!: (result: GlobalShortcutResult) => void;
    const summonReply = new Promise<GlobalShortcutResult>((resolve) => { releaseSummon = resolve; });
    const resumeBindings: Array<string | null | undefined> = [];
    let delaySummon = false;
    let suspended = false;
    const setGlobalShortcut = vi.fn((id: string, binding: string | null) => {
      if (!suspended && binding?.endsWith('+k')) return Promise.resolve<GlobalShortcutResult>({ ok: false, reason: 'conflicted' });
      pending.set(id, binding);
      return id === 'summonApp' && delaySummon ? summonReply : Promise.resolve<GlobalShortcutResult>({ ok: true });
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('kimiDesktop', {
      isScreenshotSupported: () => true,
      setGlobalShortcut,
      setGlobalShortcutSuspended: async (value: boolean) => {
        suspended = value;
        if (value) return true;
        const binding = pending.get('captureScreenshot');
        resumeBindings.push(binding);
        return !binding?.endsWith('+k');
      },
    });
    const bindings = await import('../../src/renderer/composables/useShortcuts');
    if (customized) bindings.setShortcutBinding('captureScreenshot', 'shift+mod+u');
    const previous = bindings.resolvedBinding('captureScreenshot');
    await vi.waitFor(() => expect(pending.get('captureScreenshot')).toBe(previous));
    const { default: ShortcutsPanel } = await import('../../src/renderer/components/settings/ShortcutsPanel.vue');
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(ShortcutsPanel, { initialAction: 'captureScreenshot' });
    app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: { shortcuts, common: { cancel: '取消' }, settings: { tabs: { shortcuts: '快捷键' } } } } }));
    app.mount(host);
    host.querySelector<HTMLButtonElement>('button[aria-label="编辑快捷键"]')!.click();
    await vi.waitFor(() => expect(suspended).toBe(true));
    delaySummon = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, bubbles: true }));
    await nextTick();
    await nextTick();
    await nextTick();
    await vi.waitFor(() => expect(resumeBindings).toHaveLength(1));
    await vi.waitFor(() => expect(bindings.resolvedBinding('captureScreenshot')).toBe('shift+mod+k'));
    expect(bindings.isShortcutCustomized('captureScreenshot')).toBe(true);
    releaseSummon({ ok: true });
    await vi.waitFor(() => expect(host!.textContent).toContain(shortcuts.globalTaken));
  });
});

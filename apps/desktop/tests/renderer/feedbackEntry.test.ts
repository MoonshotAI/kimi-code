// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, provide, ref, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

import UserMenu from '../../src/renderer/components/UserMenu.vue';
import GlobalFeedbackDialog from '../../src/renderer/components/feedback/GlobalFeedbackDialog.vue';
import { DesktopFeedbackKey, type GlobalFeedbackTarget } from '../../src/renderer/composables/useDesktopFeedback';

const mocks = vi.hoisted(() => ({
  membership: 'free' as string,
  confirm: vi.fn(),
  getUsage: vi.fn(async () => ({ kind: 'error' as const, message: 'offline' })),
  submitGlobal: vi.fn(async () => 42),
}));

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/client')>();
  return {
    ...actual,
    useKimiWebClient: () => ({
      managedProviderStatus: ref('authenticated'),
      managedUserInfo: ref({ userId: 'example-user', nickname: 'Example User', userLevelName: '' }),
      managedMembership: ref(mocks.membership),
      colorScheme: ref('dark'),
      setColorScheme: vi.fn(),
      getUsage: mocks.getUsage,
      logout: vi.fn(),
    }),
  };
});

vi.mock('@moonshot-ai/app-client/composables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/composables')>();
  return {
    ...actual,
    useConfirmDialog: () => ({ confirm: mocks.confirm }),
  };
});

vi.mock('../../src/renderer/composables/useShortcuts', () => ({
  resolvedBindingKeys: () => [],
}));

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let app: App | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.membership = 'free';
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function menuEntries(menu: Element): string[] {
  return Array.from(menu.children).map(child =>
    child.getAttribute('role') === 'separator'
      ? 'separator'
      : child.querySelector('.user-menu-item-label')?.textContent?.trim() ?? child.textContent?.trim() ?? '',
  );
}

describe('UserMenu feedback entry', () => {
  it('separates Report an issue from preferences and sign-out with the existing feedback icon, bilingually', async () => {
    for (const [locale, upgradeLabel, settingsLabel, appearanceLabel, languageLabel, feedbackLabel, signOutLabel] of [
      ['zh', '会员升级', '设置', '外观', '语言', '反馈问题', '退出登录'],
      ['en', 'Upgrade membership', 'Settings', 'Appearance', 'Language', 'Report an issue', 'Sign out'],
    ] as const) {
      app?.unmount();
      document.body.innerHTML = '';
      container = document.createElement('div');
      document.body.append(container);
      const onOpenFeedback = vi.fn();
      app = createApp(defineComponent(() => () => h(UserMenu, { onOpenFeedback })));
      app.use(createKimiI18n({ locale }));
      app.mount(container);
      await nextTick();

      container.querySelector<HTMLButtonElement>('.user-menu-trigger')!.click();
      await nextTick();
      await nextTick();

      const menu = document.body.querySelector('.user-menu')!;
      expect(menuEntries(menu)).toEqual([
        upgradeLabel, 'separator', settingsLabel, appearanceLabel, languageLabel,
        'separator', feedbackLabel, 'separator', signOutLabel,
      ]);
      const feedbackItem = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find(item => item.textContent?.includes(feedbackLabel))!;
      expect(feedbackItem.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

      feedbackItem.click();
      await nextTick();
      expect(onOpenFeedback).toHaveBeenCalledOnce();
      expect(container.querySelector('.user-menu-trigger')?.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('keeps Report an issue in its own group when plan usage replaces the upgrade row', async () => {
    mocks.membership = 'pro';
    app = createApp(defineComponent(() => () => h(UserMenu)));
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(container);
    await nextTick();

    container.querySelector<HTMLButtonElement>('.user-menu-trigger')!.click();
    await nextTick();
    await nextTick();

    const menu = document.body.querySelector('.user-menu')!;
    expect(menuEntries(menu)).toEqual([
      '套餐用量', 'separator', '设置', '外观', '语言', 'separator', '反馈问题', 'separator', '退出登录',
    ]);
  });
});

describe('GlobalFeedbackDialog menu entry', () => {
  function mountDialog(locale: 'zh' | 'en', target: GlobalFeedbackTarget) {
    const onClose = vi.fn();
    app = createApp(defineComponent({
      setup() {
        provide(DesktopFeedbackKey, {
          requireLogin: () => true,
          peekForm: () => undefined,
          loadForm: async () => null,
          submitGlobal: mocks.submitGlobal,
        } as never);
        return () => h(GlobalFeedbackDialog, { target, supportsSessionUpload: false, onClose });
      },
    }));
    app.use(createKimiI18n({ locale }));
    app.mount(container);
    return onClose;
  }

  it('titles the dialog Report an issue bilingually and submits the menu source', async () => {
    for (const [locale, title] of [['zh', '反馈问题'], ['en', 'Report an issue']] as const) {
      app?.unmount();
      document.body.innerHTML = '';
      container = document.createElement('div');
      document.body.append(container);
      mocks.submitGlobal.mockClear();
      const onClose = mountDialog(locale, { source: 'menu' });
      await nextTick();
      await nextTick();

      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.getAttribute('aria-label')).toBe(title);
      expect(dialog.querySelector('h2')?.textContent).toBe(title);

      const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
      textarea.value = 'Menu entry issue';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await nextTick();

      dialog.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await nextTick();
      await nextTick();

      expect(mocks.submitGlobal).toHaveBeenCalledExactlyOnceWith(
        { kind: 'global', source: 'menu', category: 'bug', content: 'Menu entry issue', session_id: undefined },
        [],
      );
      expect(onClose).toHaveBeenCalledOnce();
    }
  });
});

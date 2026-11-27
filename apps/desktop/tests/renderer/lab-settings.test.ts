// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

vi.mock('@moonshot-ai/app-markdown', () => ({
  Markdown: defineComponent({ render: () => h('div') }),
  HistoryImageCacheKey: Symbol('HistoryImageCache'),
  createHistoryImageCache: () => ({}),
}));

let app: App | null = null;

afterEach(async () => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  const { configStore } = await import('@moonshot-ai/app-client/stores');
  configStore().resetConfig();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick();
}

describe('SettingsDialog Lab two-tier layout', () => {
  it('renders Beta (context_inspector, prompt_prediction) and Experimental (notify_user, session_mentions, sidebar_multi_tab, tower)', async () => {
    vi.stubGlobal('kimiDesktop', undefined);
    const setConfig = vi.fn().mockResolvedValue({ providers: {} });
    const getMeta = vi.fn().mockResolvedValue(null);

    const { IconResolverKey } = await import('@moonshot-ai/app-ui');
    const { KimiI18nKey } = await import('@moonshot-ai/app-i18n');
    const { setKimiClientDeps } = await import('@moonshot-ai/app-client/client');
    const { useContextInspector, useSidebarTabs } = await import('@moonshot-ai/app-core/composables');
    const { clientPinia, configStore } = await import('@moonshot-ai/app-client/stores');
    const { default: i18n } = await import('../../src/renderer/i18n');
    const { default: SettingsDialog } = await import(
      '../../src/renderer/components/settings/SettingsDialog.vue'
    );

    i18n.global.locale.value = 'zh';
    useSidebarTabs().setSidebarTabs(false);
    useContextInspector().setContextInspectorEnabled(false);

    setKimiClientDeps({
      api: () => ({ setConfig, getMeta }),
      t: (key: string) => key,
    } as never);

    configStore().experimentalBeta = {
      profile: 'desktop',
      enabled: false,
      source: 'default',
      env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
    };
    configStore().experimentalFeatures = [
      {
        id: 'context_inspector',
        title: 'Context usage',
        description: 'Context inspector',
        env: 'KIMI_CODE_EXPERIMENTAL_CONTEXT_INSPECTOR',
        stage: 'beta',
        effectTiming: 'immediate',
        enabled: false,
        active: false,
        source: 'config',
        configValue: false,
      },
      {
        id: 'prompt_prediction',
        title: 'Prompt prediction',
        description: 'Next prompt placeholder',
        env: 'KIMI_CODE_EXPERIMENTAL_PROMPT_PREDICTION',
        stage: 'beta',
        effectTiming: 'immediate',
        enabled: false,
        active: false,
        source: 'default',
      },
      {
        id: 'notify_user',
        title: 'Progress updates',
        description: 'Progress updates',
        env: 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER',
        stage: 'experimental',
        effectTiming: 'next-session',
        enabled: false,
        active: false,
        source: 'config',
        configValue: false,
      },
      {
        id: 'session_mentions',
        title: 'Session mentions',
        description: 'Reference sessions',
        env: 'KIMI_CODE_EXPERIMENTAL_SESSION_MENTIONS',
        stage: 'experimental',
        effectTiming: 'immediate',
        enabled: false,
        active: false,
        source: 'default',
      },
      {
        id: 'sidebar_multi_tab',
        title: 'Tabbed session list',
        description: 'Open / Done / Projects tabs',
        env: 'KIMI_CODE_EXPERIMENTAL_SIDEBAR_MULTI_TAB',
        stage: 'experimental',
        effectTiming: 'immediate',
        enabled: false,
        active: false,
        source: 'default',
      },
      {
        id: 'tower',
        title: 'Tower mode',
        description: 'Multi-agent mode',
        env: 'KIMI_CODE_EXPERIMENTAL_TOWER',
        stage: 'experimental',
        effectTiming: 'restart',
        enabled: true,
        active: false,
        source: 'config',
        configValue: true,
      },
    ];
    configStore().experimentalFlags = {
      context_inspector: false,
      prompt_prediction: false,
      notify_user: false,
      session_mentions: false,
      sidebar_multi_tab: false,
      tower: false,
    };

    const host = document.createElement('div');
    document.body.append(host);
    app = createApp({
      render: () =>
        h(SettingsDialog, {
          colorScheme: 'light',
          fontScale: 'medium',
          notify: false,
          notifySound: false,
          onFetchUsage: async () => ({ kind: 'error' }) as never,
        }),
    });
    app.use(i18n);
    app.use(clientPinia);
    app.provide(KimiI18nKey, { t: (key: string) => key });
    app.provide(IconResolverKey, () => defineComponent({ render: () => h('svg') }));
    app.mount(host);
    await flush();

    const generalPanel = document.querySelectorAll('section.panel')[0]!;
    expect(
      generalPanel.querySelector('button[role="switch"][aria-label="多标签页的会话列表"]'),
    ).toBeNull();

    const labTabButton = [...document.querySelectorAll<HTMLButtonElement>('button.tab')].find((btn) =>
      btn.textContent?.includes('实验室'),
    );
    expect(labTabButton).not.toBeUndefined();
    labTabButton!.click();
    await flush();

    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('Beta 功能');
    expect(bodyText).toContain('即将推出，欢迎尝鲜');
    expect(bodyText).toContain('实验性功能');
    expect(bodyText).toContain('Agent 体验与形态探索，尚未定型，建议了解后按需开启');
    expect(bodyText).not.toContain('抢先体验');
    expect(bodyText).not.toContain('先锋探索');
    expect(bodyText).toContain('重启 Kimi Code 后生效');

    const labPanel = [...document.querySelectorAll<HTMLElement>('section.panel')].find(
      (el) => el.style.display !== 'none',
    )!;
    const labSections = labPanel.querySelectorAll('section.sec');
    expect(labSections).toHaveLength(2);
    expect(
      labSections[0]!.querySelector('.lab-beta-toggle-label')?.textContent,
    ).toBe('全部');
    expect(
      labSections[0]!.querySelector('.lab-sec-head button[role="switch"][aria-label="开启全部 Beta 功能"]'),
    ).not.toBeNull();
    expect(
      labSections[0]!.querySelector('.settings-group button[role="switch"][aria-label="开启全部 Beta 功能"]'),
    ).toBeNull();
    expect(labSections[0]!.querySelectorAll('.settings-group .row')).toHaveLength(2);

    const betaMasterSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="开启全部 Beta 功能"]',
    )!;
    const contextSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="上下文用量"]',
    )!;
    const promptPredictionSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="提示词预测"]',
    )!;
    const notifySwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="进展更新"]',
    )!;
    const sessionMentionsSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="引用会话"]',
    )!;
    const sidebarTabsSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="多标签页的会话列表"]',
    )!;
    const towerSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Tower 多 Agent 协作模式"]',
    )!;

    expect(contextSwitch.getAttribute('aria-checked')).toBe('false');
    expect(promptPredictionSwitch.getAttribute('aria-checked')).toBe('false');
    expect(notifySwitch.getAttribute('aria-checked')).toBe('false');
    expect(sessionMentionsSwitch.getAttribute('aria-checked')).toBe('false');
    expect(sidebarTabsSwitch.getAttribute('aria-checked')).toBe('false');
    expect(towerSwitch.getAttribute('aria-checked')).toBe('true');

    betaMasterSwitch.click();
    await flush();

    expect(setConfig).toHaveBeenCalledWith({ experimental: { desktop: { beta: true } } });
    expect(contextSwitch.getAttribute('aria-checked')).toBe('true');
    expect(contextSwitch.disabled).toBe(true);
    expect(promptPredictionSwitch.getAttribute('aria-checked')).toBe('true');
    expect(promptPredictionSwitch.disabled).toBe(true);
    expect(document.body.textContent).not.toContain('已随「开启全部 Beta 功能」开启');
    expect(notifySwitch.getAttribute('aria-checked')).toBe('false');
    expect(notifySwitch.disabled).toBe(false);
    expect(sessionMentionsSwitch.getAttribute('aria-checked')).toBe('false');
    expect(sessionMentionsSwitch.disabled).toBe(false);
    expect(sidebarTabsSwitch.getAttribute('aria-checked')).toBe('false');
    expect(sidebarTabsSwitch.disabled).toBe(false);
    expect(localStorage.getItem(STORAGE_KEYS.contextInspector)).toBeNull();

    betaMasterSwitch.click();
    await flush();

    expect(contextSwitch.getAttribute('aria-checked')).toBe('false');
    expect(contextSwitch.disabled).toBe(false);
    expect(promptPredictionSwitch.getAttribute('aria-checked')).toBe('false');
    expect(promptPredictionSwitch.disabled).toBe(false);

    contextSwitch.click();
    await flush();
    expect(setConfig).toHaveBeenCalledWith({
      experimental: { desktop: { context_inspector: true } },
    });
    expect(contextSwitch.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(STORAGE_KEYS.contextInspector)).toBeNull();

    notifySwitch.click();
    await flush();
    expect(setConfig).toHaveBeenCalledWith({ experimental: { desktop: { notify_user: true } } });
    expect(notifySwitch.getAttribute('aria-checked')).toBe('true');

    sessionMentionsSwitch.click();
    await flush();
    expect(setConfig).toHaveBeenCalledWith({
      experimental: { desktop: { session_mentions: true } },
    });
    expect(sessionMentionsSwitch.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(STORAGE_KEYS.sessionMentions)).toBeNull();

    sidebarTabsSwitch.click();
    await flush();
    expect(setConfig).toHaveBeenCalledWith({
      experimental: { desktop: { sidebar_multi_tab: true } },
    });
    expect(sidebarTabsSwitch.getAttribute('aria-checked')).toBe('true');
    expect(useSidebarTabs().sidebarTabs.value).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.sidebarMultiTab)).toBeNull();

    promptPredictionSwitch.click();
    await flush();

    expect(setConfig).toHaveBeenCalledWith({
      experimental: { desktop: { prompt_prediction: true } },
    });
    expect(promptPredictionSwitch.getAttribute('aria-checked')).toBe('true');

    configStore().experimentalFeatures = configStore().experimentalFeatures.map((feature) =>
      feature.id === 'prompt_prediction'
        ? { ...feature, enabled: true, active: true, source: 'env' }
        : feature,
    );
    await flush();

    expect(promptPredictionSwitch.disabled).toBe(true);
    expect(document.body.textContent).toContain('KIMI_CODE_EXPERIMENTAL_PROMPT_PREDICTION');

    configStore().experimentalBeta = null;
    await flush();
    expect(
      document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="开启全部 Beta 功能"]'),
    ).toBeNull();
  }, 60_000);
});

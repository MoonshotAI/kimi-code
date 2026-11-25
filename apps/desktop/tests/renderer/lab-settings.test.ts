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

describe('SettingsDialog General sidebarTabs and Lab two-tier layout', () => {
  it('places Tabbed session list in General -> Appearance and splits Lab into Beta and Experimental', async () => {
    vi.stubGlobal('kimiDesktop', undefined);
    const setConfig = vi.fn().mockResolvedValue({ providers: {} });
    const getMeta = vi.fn().mockResolvedValue(null);

    const { IconResolverKey } = await import('@moonshot-ai/app-ui');
    const { KimiI18nKey } = await import('@moonshot-ai/app-i18n');
    const { setKimiClientDeps } = await import('@moonshot-ai/app-client/client');
    const { useContextInspector, useSidebarTabs } = await import('@moonshot-ai/app-core');
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
        id: 'notify_user',
        title: 'NotifyUser tool',
        description: 'Progress updates',
        env: 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER',
        stage: 'beta',
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
        id: 'prompt_prediction',
        title: 'Prompt prediction',
        description: 'Next prompt placeholder',
        env: 'KIMI_CODE_EXPERIMENTAL_PROMPT_PREDICTION',
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
      notify_user: false,
      session_mentions: false,
      prompt_prediction: false,
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

    const generalSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="多标签页的会话列表"]',
    );
    expect(generalSwitch).not.toBeNull();
    generalSwitch!.click();
    await flush();
    expect(localStorage.getItem(STORAGE_KEYS.sidebarMultiTab)).toBe('1');

    const labTabButton = [...document.querySelectorAll<HTMLButtonElement>('button.tab')].find((btn) =>
      btn.textContent?.includes('实验室'),
    );
    expect(labTabButton).not.toBeUndefined();
    labTabButton!.click();
    await flush();

    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('Beta 功能');
    expect(bodyText).toContain('实验性功能');
    expect(bodyText).not.toContain('抢先体验');
    expect(bodyText).not.toContain('先锋探索');
    expect(bodyText).toContain('重启 Kimi Code 后生效');

    const betaMasterSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="开启全部 Beta 功能"]',
    )!;
    const contextSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="上下文用量"]',
    )!;
    const notifySwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="进展更新"]',
    )!;
    const sessionMentionsSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="引用会话"]',
    )!;
    const promptPredictionSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="提示词预测"]',
    )!;
    const towerSwitch = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Tower 多 Agent 协作模式"]',
    )!;

    expect(contextSwitch.getAttribute('aria-checked')).toBe('false');
    expect(notifySwitch.getAttribute('aria-checked')).toBe('false');
    expect(sessionMentionsSwitch.getAttribute('aria-checked')).toBe('false');
    expect(promptPredictionSwitch.getAttribute('aria-checked')).toBe('false');
    expect(towerSwitch.getAttribute('aria-checked')).toBe('true');

    betaMasterSwitch.click();
    await flush();

    expect(setConfig).toHaveBeenCalledWith({ experimental: { beta: true } });
    expect(contextSwitch.getAttribute('aria-checked')).toBe('true');
    expect(contextSwitch.disabled).toBe(true);
    expect(notifySwitch.getAttribute('aria-checked')).toBe('true');
    expect(notifySwitch.disabled).toBe(true);
    expect(sessionMentionsSwitch.getAttribute('aria-checked')).toBe('false');
    expect(sessionMentionsSwitch.disabled).toBe(false);
    expect(promptPredictionSwitch.getAttribute('aria-checked')).toBe('false');
    expect(promptPredictionSwitch.disabled).toBe(false);
    expect(localStorage.getItem(STORAGE_KEYS.contextInspector)).toBeNull();

    betaMasterSwitch.click();
    await flush();

    expect(contextSwitch.getAttribute('aria-checked')).toBe('false');
    expect(contextSwitch.disabled).toBe(false);
    expect(notifySwitch.getAttribute('aria-checked')).toBe('false');
    expect(notifySwitch.disabled).toBe(false);

    contextSwitch.click();
    await flush();
    expect(setConfig).toHaveBeenCalledWith({ experimental: { context_inspector: true } });
    expect(contextSwitch.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(STORAGE_KEYS.contextInspector)).toBeNull();

    sessionMentionsSwitch.click();
    await flush();
    expect(setConfig).toHaveBeenCalledWith({ experimental: { session_mentions: true } });
    expect(sessionMentionsSwitch.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(STORAGE_KEYS.sessionMentions)).toBeNull();

    promptPredictionSwitch.click();
    await flush();

    expect(setConfig).toHaveBeenCalledWith({ experimental: { prompt_prediction: true } });
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

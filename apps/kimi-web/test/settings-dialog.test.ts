import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it } from 'vitest';

import SettingsDialog from '../src/components/SettingsDialog.vue';
import enSettings from '../src/i18n/locales/en/settings';
import type { AppConfig, AppModel } from '../src/api/types';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      settings: enSettings,
      theme: {
        label: 'Theme',
        modern: 'Modern',
        kimi: 'Kimi',
        colorSchemeLabel: 'Color scheme',
        light: 'Light',
        dark: 'Dark',
        system: 'System',
      },
      sidebar: {
        daemon: 'Daemon',
        language: 'Language',
        notSignedIn: 'Not signed in',
        signIn: 'Sign in',
        signOut: 'Sign out',
      },
      onboarding: { reopen: 'Open onboarding' },
      newSession: { close: 'Close' },
    },
  },
  missingWarn: false,
  fallbackWarn: false,
});

const config: AppConfig = {
  providers: {
    kimi: {
      type: 'moonshot',
      defaultModel: 'kimi/k2',
      hasApiKey: true,
    },
    openai: {
      type: 'openai',
      hasApiKey: false,
    },
  },
  defaultModel: 'kimi/k2',
  models: {
    'kimi/k2': { provider: 'kimi', model: 'k2' },
    'openai/gpt-5': { provider: 'openai', model: 'gpt-5' },
  },
  defaultPermissionMode: 'manual',
  defaultThinking: true,
  defaultPlanMode: false,
  mergeAllAvailableSkills: false,
  telemetry: true,
  raw: { secret: 'must-not-render' },
};

const models: AppModel[] = [
  {
    id: 'kimi/k2',
    provider: 'kimi',
    model: 'k2',
    displayName: 'Kimi K2',
    maxContextSize: 128000,
  },
  {
    id: 'openai/gpt-5',
    provider: 'openai',
    model: 'gpt-5',
    displayName: 'GPT-5',
    maxContextSize: 256000,
  },
];

function mountDialog() {
  return mount(SettingsDialog, {
    props: {
      theme: 'modern',
      colorScheme: 'system',
      uiFontSize: 15,
      authReady: true,
      accountModel: 'kimi/k2',
      notify: true,
      notifyPermission: 'granted',
      betaToc: false,
      config,
      models,
      configSaving: false,
    },
    global: {
      plugins: [i18n],
      stubs: { LanguageSwitcher: true },
    },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SettingsDialog config controls', () => {
  it('renders redacted daemon config and emits partial config patches', async () => {
    const wrapper = mountDialog();

    expect(wrapper.text()).toContain('Agent defaults');
    expect(wrapper.text()).toContain('Kimi K2');
    expect(wrapper.text()).toContain('Credential configured');
    expect(wrapper.text()).toContain('Missing credential');
    expect(wrapper.text()).not.toContain('must-not-render');

    await wrapper.find('.select-field').setValue('openai/gpt-5');
    expect(wrapper.emitted('updateConfig')?.[0]?.[0]).toEqual({ defaultModel: 'openai/gpt-5' });

    const auto = wrapper.findAll('.opt').find((button) => button.text() === 'Auto');
    await auto!.trigger('click');
    expect(wrapper.emitted('updateConfig')?.[1]?.[0]).toEqual({ defaultPermissionMode: 'auto' });

    const planRow = wrapper.findAll('.row').find((row) => row.text().includes('Plan mode by default'));
    await planRow!.find('button.switch').trigger('click');
    expect(wrapper.emitted('updateConfig')?.[2]?.[0]).toEqual({ defaultPlanMode: true });
  });
});

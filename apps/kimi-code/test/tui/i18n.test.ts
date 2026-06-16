import { describe, expect, it } from 'vitest';

import { I18n, resolveLocale } from '#/tui/i18n';

const messages = {
  en: {
    components: {
      footer: { context: 'context', greeting: 'Hi {name}', thinking: 'thinking' },
    },
  },
  'zh-CN': {
    components: {
      footer: { context: '上下文', greeting: '你好 {name}' },
    },
  },
};

describe('I18n', () => {
  it('looks up a key in the active locale', () => {
    const i18n = new I18n(messages, 'en');

    expect(i18n.t('components.footer.context')).toBe('context');
  });

  it('resolves the active locale over the fallback', () => {
    const i18n = new I18n(messages, 'zh-CN');

    expect(i18n.t('components.footer.context')).toBe('上下文');
  });

  it('falls back to the default locale when a key is missing in the active locale', () => {
    const i18n = new I18n(messages, 'zh-CN');

    // `thinking` only exists in the `en` pack.
    expect(i18n.t('components.footer.thinking')).toBe('thinking');
  });

  it('returns the raw key when it is missing in every locale', () => {
    const i18n = new I18n(messages, 'en');

    expect(i18n.t('components.footer.nope')).toBe('components.footer.nope');
  });

  it('interpolates named params', () => {
    const i18n = new I18n(messages, 'zh-CN');

    expect(i18n.t('components.footer.greeting', { name: 'Kimi' })).toBe('你好 Kimi');
  });

  it('switches the active locale at runtime via setLocale', () => {
    const i18n = new I18n(messages, 'en');
    expect(i18n.t('components.footer.context')).toBe('context');

    i18n.setLocale('zh-CN');

    expect(i18n.t('components.footer.context')).toBe('上下文');
  });
});

describe('resolveLocale', () => {
  it('passes through an explicit locale preference without consulting the env', () => {
    expect(resolveLocale('en', { LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(resolveLocale('zh-CN', { LANG: 'en_US.UTF-8' })).toBe('zh-CN');
  });

  it('resolves auto to zh-CN for Chinese locales and their variants', () => {
    expect(resolveLocale('auto', { LANG: 'zh_CN.UTF-8' })).toBe('zh-CN');
    expect(resolveLocale('auto', { LANG: 'zh_CN' })).toBe('zh-CN');
    expect(resolveLocale('auto', { LANG: 'zh-CN' })).toBe('zh-CN');
  });

  it('resolves auto to en for English, C, and unknown locales', () => {
    expect(resolveLocale('auto', { LANG: 'en_US.UTF-8' })).toBe('en');
    expect(resolveLocale('auto', { LANG: 'C.UTF-8' })).toBe('en');
    expect(resolveLocale('auto', { LANG: 'POSIX' })).toBe('en');
    expect(resolveLocale('auto', { LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(resolveLocale('auto', {})).toBe('en');
  });

  it('honours LC_ALL over LC_MESSAGES over LANG', () => {
    expect(resolveLocale('auto', { LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh-CN');
    expect(resolveLocale('auto', { LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh-CN');
    expect(resolveLocale('auto', { LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'zh_CN.UTF-8' })).toBe('en');
  });
});

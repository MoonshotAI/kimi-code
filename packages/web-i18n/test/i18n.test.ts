import { describe, expect, it } from 'vitest';
import { createApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { createKimiI18n, KimiI18nKey, useKimiI18n } from '../src';

describe('createKimiI18n', () => {
  it('returns the Chinese message for locale "zh"', () => {
    const i18n = createKimiI18n({ locale: 'zh' });
    expect(i18n.global.t('filePreview.copyCode')).toBe('复制代码');
  });

  it('returns the English message for locale "en"', () => {
    const i18n = createKimiI18n({ locale: 'en' });
    expect(i18n.global.t('filePreview.copyCode')).toBe('Copy code');
  });

  it('renders the /goal description in full (pipe chars are escaped literals, not plural separators)', () => {
    const i18n = createKimiI18n({ locale: 'en' });
    expect(i18n.global.t('commands.goal.desc')).toBe(
      'Create/control a goal: /goal <objective>, /goal pause|resume|cancel',
    );
  });
});

describe('useKimiI18n', () => {
  it('prefers the app-provided KimiI18nKey over the global vue-i18n', () => {
    const globalI18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { filePreview: { copyCode: 'GLOBAL' } } },
    });
    const app = createApp({});
    app.use(globalI18n);
    app.provide(KimiI18nKey, { t: (key: string) => `INJECTED:${key}` });

    let resolved = '';
    app.runWithContext(() => {
      resolved = useKimiI18n().t('filePreview.copyCode');
    });
    expect(resolved).toBe('INJECTED:filePreview.copyCode');
  });
});

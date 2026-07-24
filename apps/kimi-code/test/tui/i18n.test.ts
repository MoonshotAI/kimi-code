import { describe, expect, it } from 'vitest';

import { getLanguage, setLanguage, t } from '#/tui/i18n';

describe('i18n', () => {
  it('defaults to English', () => {
    expect(getLanguage()).toBe('en');
  });

  it('returns English strings by default', () => {
    expect(t('settings.title')).toBe('Settings');
    expect(t('welcome.title')).toBe('Welcome to Kimi Code!');
  });

  it('switches to Chinese', () => {
    setLanguage('zh');
    try {
      expect(getLanguage()).toBe('zh');
      expect(t('settings.title')).toBe('设置');
      expect(t('welcome.title')).toBe('欢迎使用 Kimi Code！');
    } finally {
      setLanguage('en');
    }
  });

  it('interpolates variables', () => {
    expect(t('footer.context', { pct: '42' })).toBe('context: 42%');
    setLanguage('zh');
    try {
      expect(t('footer.context', { pct: '42' })).toBe('上下文：42%');
    } finally {
      setLanguage('en');
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { t, setLocale, getLocale } from '#/i18n';
import en from '#/i18n/locales/en';
import zh from '#/i18n/locales/zh';

describe('i18n', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    setLocale('en');
  });

  describe('t()', () => {
    it('returns the English string for a known key', () => {
      expect(t('common.ok')).toBe('OK');
    });

    it('returns the Chinese string when locale is zh', () => {
      setLocale('zh');
      expect(t('common.ok')).toBe('确定');
    });

    it('returns the key itself when key does not exist in any locale', () => {
      expect(t('nonexistent.key.here')).toBe('nonexistent.key.here');
    });

    it('interpolates {{param}} placeholders', () => {
      setLocale('en');
      expect(t('tui.statusMessages.shellCommandFailed', { message: 'ENOENT' })).toContain('ENOENT');
    });

    it('handles empty params object', () => {
      setLocale('en');
      expect(t('common.ok', {})).toBe('OK');
    });

    it('handles multiple params', () => {
      setLocale('en');
      const result = t('tui.statusMessages.unsupportedEffort', {
        arg: 'high',
        alias: 'gpt-4',
        segments: 'low, medium',
      });
      expect(result).toContain('high');
      expect(result).toContain('gpt-4');
      expect(result).toContain('low, medium');
    });

    it('keeps placeholder when param is missing', () => {
      setLocale('en');
      const result = t('tui.statusMessages.shellCommandFailed', {});
      expect(result).toContain('{{message}}');
    });
  });

  describe('setLocale() / getLocale()', () => {
    it('getLocale returns the current locale', () => {
      setLocale('zh');
      expect(getLocale()).toBe('zh');
      setLocale('en');
      expect(getLocale()).toBe('en');
    });

    it('setLocale ignores invalid locale values', () => {
      setLocale('en');
      setLocale('fr' as any);
      expect(getLocale()).toBe('en');
    });
  });

  describe('locale key consistency', () => {
    type MessageValue = string | { [key: string]: MessageValue };

    function collectLeafKeys(obj: MessageValue, prefix = ''): string[] {
      const keys: string[] = [];
      for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        const value = (obj as Record<string, MessageValue>)[key];
        if (typeof value === 'object' && value !== null) {
          keys.push(...collectLeafKeys(value, fullKey));
        } else {
          keys.push(fullKey);
        }
      }
      return keys;
    }

    const enKeys = collectLeafKeys(en as unknown as MessageValue);
    const zhKeys = collectLeafKeys(zh as unknown as MessageValue);

    it('en and zh have the same number of leaf keys', () => {
      expect(enKeys.length).toBe(zhKeys.length);
    });

    it('every en key exists in zh', () => {
      const zhSet = new Set(zhKeys);
      const missing = enKeys.filter((k) => !zhSet.has(k));
      expect(missing).toEqual([]);
    });

    it('every zh key exists in en', () => {
      const enSet = new Set(enKeys);
      const missing = zhKeys.filter((k) => !enSet.has(k));
      expect(missing).toEqual([]);
    });
  });
});
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { t, setLocale, getLocale } from '#/i18n';
import en from '#/locales/en';
import zh from '#/locales/zh';

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
      expect(t('errors.sessionNotFound')).toBe('Session not found');
    });

    it('returns the Chinese string when locale is zh', () => {
      setLocale('zh');
      expect(t('errors.sessionNotFound')).toBe('未找到会话');
    });

    it('returns the key itself when key does not exist in any locale', () => {
      expect(t('nonexistent.key.here')).toBe('nonexistent.key.here');
    });

    it('interpolates {{param}} placeholders', () => {
      expect(t('plugin.manifestNotFound', { path: '/foo/bar' })).toContain('/foo/bar');
    });

    it('handles empty params object', () => {
      expect(t('errors.internal', {})).toBe('Internal error');
    });

    it('handles multiple params', () => {
      setLocale('en');
      const result = t('v2Errors.goalObjectiveTooLongAction', { max: '4000' });
      expect(result).toContain('4000');
    });

    it('keeps placeholder when param is missing', () => {
      const result = t('plugin.manifestNotFound', {});
      expect(result).toContain('{{path}}');
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

  describe('toolsV2 interpolation', () => {
    it('interpolates planMode keys with params', () => {
      expect(t('toolsV2.planMode.exitFailedDetail', { message: 'timeout' })).toContain('timeout');
      expect(t('toolsV2.planMode.noPlanFileDetail', { path: '/tmp/plan.md' })).toContain('/tmp/plan.md');
      expect(t('toolsV2.planMode.planSaved', { path: '/tmp/plan.md' })).toContain('/tmp/plan.md');
    });

    it('interpolates task keys with params', () => {
      expect(t('toolsV2.task.notFound', { taskId: 'bash-abc123' })).toContain('bash-abc123');
      expect(t('toolsV2.task.stopFailed', { taskId: 'bash-abc123' })).toContain('bash-abc123');
      expect(t('toolsV2.task.outputTruncatedHint', { bytes: '1024' })).toContain('1024');
    });

    it('interpolates agent keys with params', () => {
      expect(t('toolsV2.agent.resumeHint', { agentId: 'agent-xyz' })).toContain('agent-xyz');
    });

    it('interpolates readMedia keys with params', () => {
      expect(t('toolsV2.readMedia.fileTooLarge', { path: 'big.jpg', size: '999999', max: '50' })).toContain('big.jpg');
      expect(t('toolsV2.readMedia.fileTooLarge', { path: 'big.jpg', size: '999999', max: '50' })).toContain('50');
    });

    it('interpolates abort keys (no params)', () => {
      expect(t('toolsV2.abort.abortedByUser')).toBe('Aborted by the user');
    });

    it('interpolates selectTools keys with params', () => {
      expect(t('toolsV2.selectTools.loaded', { tools: 'Read, Write' })).toContain('Read, Write');
    });

    it('interpolates goal keys (no params)', () => {
      expect(t('toolsV2.goal.creating')).toBe('Creating a goal');
    });
  });

  describe('no single-brace placeholders', () => {
    it('all toolsV2 value strings use {{param}} not {param}', () => {
      const raw = (en as unknown as Record<string, unknown>).toolsV2 as Record<string, unknown>;
      const visited = new Set<string>();

      function walk(obj: unknown, path: string): void {
        if (obj === null || typeof obj !== 'object') return;
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
          const fullKey = path ? `${path}.${key}` : key;
          if (typeof value === 'string') {
            visited.add(fullKey);
            // Match single-brace {word} that is NOT a JSX/React pattern
            const singleBrace = value.match(/(?<!\{)\{([a-zA-Z_][a-zA-Z0-9_]*)\}(?!\})/);
            if (singleBrace) {
              // Exception: only JS escape sequences like \n should not be flagged
              const prefix = value.substring(0, Math.max(0, singleBrace.index! - 1));
              if (!prefix.endsWith('\\')) {
                expect.unreachable(`toolsV2.${fullKey} has single-brace placeholder "${singleBrace[0]}" in "${value}"`);
              }
            }
          } else {
            walk(value, fullKey);
          }
        }
      }

      walk(en, '');
    });
  }); // no single-brace placeholders

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
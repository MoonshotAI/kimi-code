import { describe, it, expect } from 'vitest';
import { messages } from '../src/i18n/locales';

describe('AsyncErrorFallback i18n keys', () => {
  it('en common has loadErrorTitle and loadErrorRetry', () => {
    const common = (messages.en as any).common;
    expect(common.loadErrorTitle).toBeTypeOf('string');
    expect(common.loadErrorRetry).toBeTypeOf('string');
  });

  it('zh common has loadErrorTitle and loadErrorRetry', () => {
    const common = (messages.zh as any).common;
    expect(common.loadErrorTitle).toBeTypeOf('string');
    expect(common.loadErrorRetry).toBeTypeOf('string');
  });

  it('keys are non-empty', () => {
    const en = (messages.en as any).common;
    const zh = (messages.zh as any).common;
    expect(en.loadErrorTitle.length).toBeGreaterThan(0);
    expect(en.loadErrorRetry.length).toBeGreaterThan(0);
    expect(zh.loadErrorTitle.length).toBeGreaterThan(0);
    expect(zh.loadErrorRetry.length).toBeGreaterThan(0);
  });
});

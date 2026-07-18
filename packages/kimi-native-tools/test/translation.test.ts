import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Load the native module
const native = require('../index.js');

// ── Test data ────────────────────────────────────────────────────────────────

const enJson = JSON.stringify({
  common: {
    ok: 'OK',
    cancel: 'Cancel',
    greeting: 'Hello, {{name}}!',
  },
  errors: {
    notFound: '{{item}} not found',
    multi: 'Found {{count}} {{item}}s in {{location}}',
  },
  deep: {
    nested: {
      key: 'Deep value',
    },
  },
});

const zhJson = JSON.stringify({
  common: {
    ok: '确定',
    cancel: '取消',
    greeting: '你好，{{name}}！',
  },
  errors: {
    notFound: '未找到{{item}}',
  },
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('nativeTranslate', () => {
  it('resolves a simple key from locale JSON', () => {
    expect(native.nativeTranslate(enJson, enJson, 'common.ok')).toBe('OK');
  });

  it('falls back to the fallback JSON when key is missing in locale', () => {
    // 'deep.nested.key' only exists in en
    expect(native.nativeTranslate(zhJson, enJson, 'deep.nested.key')).toBe('Deep value');
  });

  it('returns the key itself when not found in either locale', () => {
    expect(native.nativeTranslate(enJson, enJson, 'nonexistent.key')).toBe('nonexistent.key');
  });

  it('interpolates {{param}} placeholders', () => {
    const result = native.nativeTranslate(enJson, enJson, 'common.greeting', { name: 'World' });
    expect(result).toBe('Hello, World!');
  });

  it('interpolates multiple params', () => {
    const result = native.nativeTranslate(enJson, enJson, 'errors.multi', {
      count: '3',
      item: 'File',
      location: 'database',
    });
    expect(result).toBe('Found 3 Files in database');
  });

  it('keeps placeholder when param is missing', () => {
    const result = native.nativeTranslate(enJson, enJson, 'common.greeting', {});
    expect(result).toBe('Hello, {{name}}!');
  });

  it('works without params argument', () => {
    expect(native.nativeTranslate(enJson, enJson, 'common.ok')).toBe('OK');
  });

  it('resolves Chinese locale', () => {
    expect(native.nativeTranslate(zhJson, enJson, 'common.ok')).toBe('确定');
  });

  it('resolves deeply nested keys', () => {
    expect(native.nativeTranslate(enJson, enJson, 'deep.nested.key')).toBe('Deep value');
  });
});

describe('nativeTranslateCached', () => {
  beforeEach(() => {
    native.nativeTranslateClearCache();
  });

  afterEach(() => {
    native.nativeTranslateClearCache();
  });

  it('produces identical results to nativeTranslate', () => {
    const uncached = native.nativeTranslate(zhJson, enJson, 'common.greeting', { name: 'Rust' });
    const cached = native.nativeTranslateCached(zhJson, enJson, 'common.greeting', { name: 'Rust' });
    expect(cached).toBe(uncached);
    expect(cached).toBe('你好，Rust！');
  });

  it('caches across calls with the same locale JSON', () => {
    // First call — populates cache
    const r1 = native.nativeTranslateCached(enJson, enJson, 'common.ok');
    expect(r1).toBe('OK');

    // Second call — should use cache (same JSON string)
    const r2 = native.nativeTranslateCached(enJson, enJson, 'common.ok');
    expect(r2).toBe('OK');
  });

  it('handles locale switching correctly', () => {
    // Call with English
    expect(native.nativeTranslateCached(enJson, enJson, 'common.ok')).toBe('OK');
    // Call with Chinese — different JSON string, different cache entry
    expect(native.nativeTranslateCached(zhJson, enJson, 'common.ok')).toBe('确定');
    // Both should work independently
    expect(native.nativeTranslateCached(enJson, enJson, 'common.ok')).toBe('OK');
    expect(native.nativeTranslateCached(zhJson, enJson, 'common.ok')).toBe('确定');
  });

  it('handles fallback correctly', () => {
    // 'deep.nested.key' only in en
    expect(native.nativeTranslateCached(zhJson, enJson, 'deep.nested.key')).toBe('Deep value');
  });

  it('handles missing key', () => {
    expect(native.nativeTranslateCached(enJson, enJson, 'nonexistent.key')).toBe('nonexistent.key');
  });

  it('clears cache on nativeTranslateClearCache', () => {
    // Populate cache
    native.nativeTranslateCached(enJson, enJson, 'common.ok');
    // Clear cache
    native.nativeTranslateClearCache();
    // Should still work (re-parses)
    expect(native.nativeTranslateCached(enJson, enJson, 'common.ok')).toBe('OK');
  });
});

describe('nativeTranslateBatch', () => {
  it('resolves multiple keys in a single call', () => {
    const results = native.nativeTranslateBatch(enJson, enJson, [
      'common.ok',
      'common.cancel',
      'nonexistent.key',
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ key: 'common.ok', message: 'OK' });
    expect(results[1]).toEqual({ key: 'common.cancel', message: 'Cancel' });
    expect(results[2]).toEqual({ key: 'nonexistent.key', message: 'nonexistent.key' });
  });

  it('interpolates params for all keys', () => {
    const results = native.nativeTranslateBatch(
      zhJson,
      enJson,
      ['common.greeting', 'errors.notFound'],
      { name: 'Alice', item: 'File' },
    );
    expect(results[0].message).toBe('你好，Alice！');
    expect(results[1].message).toBe('未找到File');
  });

  it('handles empty keys array', () => {
    const results = native.nativeTranslateBatch(enJson, enJson, []);
    expect(results).toEqual([]);
  });

  it('falls back to English for missing Chinese keys', () => {
    const results = native.nativeTranslateBatch(zhJson, enJson, ['deep.nested.key']);
    expect(results[0].message).toBe('Deep value');
  });
});

describe('nativeTranslateBatchCached', () => {
  beforeEach(() => {
    native.nativeTranslateClearCache();
  });

  afterEach(() => {
    native.nativeTranslateClearCache();
  });

  it('produces identical results to nativeTranslateBatch', () => {
    const keys = ['common.ok', 'common.greeting', 'nonexistent.key'];
    const params = { name: 'Test' };

    const uncached = native.nativeTranslateBatch(enJson, enJson, keys, params);
    const cached = native.nativeTranslateBatchCached(enJson, enJson, keys, params);

    expect(cached).toEqual(uncached);
    expect(cached).toHaveLength(3);
  });

  it('caches across batch calls', () => {
    const keys = ['common.ok', 'common.cancel'];

    // First call — populates cache
    const r1 = native.nativeTranslateBatchCached(enJson, enJson, keys);
    // Second call — should use cache
    const r2 = native.nativeTranslateBatchCached(enJson, enJson, keys);

    expect(r1).toEqual(r2);
    expect(r1[0].message).toBe('OK');
    expect(r1[1].message).toBe('Cancel');
  });

  it('handles locale switching', () => {
    const keys = ['common.ok'];

    expect(native.nativeTranslateBatchCached(enJson, enJson, keys)[0].message).toBe('OK');
    expect(native.nativeTranslateBatchCached(zhJson, enJson, keys)[0].message).toBe('确定');
  });
});

describe('nativeTranslateClearCache', () => {
  it('is safe to call on an empty cache', () => {
    native.nativeTranslateClearCache();
    native.nativeTranslateClearCache();
    // Should not throw
  });

  it('clears the cache without breaking subsequent calls', () => {
    native.nativeTranslateCached(enJson, enJson, 'common.ok');
    native.nativeTranslateClearCache();
    expect(native.nativeTranslateCached(enJson, enJson, 'common.ok')).toBe('OK');
  });
});

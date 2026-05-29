import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiKeyPool } from '../../src/session/api-key-pool';

describe('ApiKeyPool', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TEST_API_KEY')) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    vi.useRealTimers();
  });

  describe('fromEnv', () => {
    it('returns null when no keys are present', () => {
      delete process.env['TEST_API_KEY'];
      expect(ApiKeyPool.fromEnv('TEST_API_KEY')).toBeNull();
    });

    it('returns null when only one key is present', () => {
      process.env['TEST_API_KEY'] = 'sk-one';
      expect(ApiKeyPool.fromEnv('TEST_API_KEY')).toBeNull();
    });

    it('collects primary + numbered keys', () => {
      process.env['TEST_API_KEY'] = 'sk-primary';
      process.env['TEST_API_KEY_1'] = 'sk-1';
      process.env['TEST_API_KEY_2'] = 'sk-2';
      const pool = ApiKeyPool.fromEnv('TEST_API_KEY');
      expect(pool).not.toBeNull();
      expect(pool!.keyCount).toBe(3);
    });

    it('ignores gaps in numbering', () => {
      process.env['TEST_API_KEY'] = 'sk-primary';
      process.env['TEST_API_KEY_5'] = 'sk-5';
      const pool = ApiKeyPool.fromEnv('TEST_API_KEY');
      expect(pool).not.toBeNull();
      expect(pool!.keyCount).toBe(2);
    });

    it('ignores empty keys', () => {
      process.env['TEST_API_KEY'] = 'sk-primary';
      process.env['TEST_API_KEY_1'] = '';
      process.env['TEST_API_KEY_2'] = 'sk-2';
      const pool = ApiKeyPool.fromEnv('TEST_API_KEY');
      expect(pool).not.toBeNull();
      expect(pool!.keyCount).toBe(2);
    });

    it('defaults to KIMI_API_KEY prefix', () => {
      // Use a unique prefix to avoid colliding with real environment keys.
      const prefix = `TEST_DEFAULT_${Date.now()}`;
      process.env[prefix] = 'sk-a';
      process.env[`${prefix}_1`] = 'sk-b';
      const pool = ApiKeyPool.fromEnv(prefix);
      expect(pool).not.toBeNull();
      expect(pool!.keyCount).toBe(2);
      delete process.env[prefix];
      delete process.env[`${prefix}_1`];
    });
  });

  describe('constructor', () => {
    it('throws when keys array is empty', () => {
      expect(() => new ApiKeyPool([])).toThrow('Key pool cannot be empty');
    });

    it('accepts a non-empty keys array', () => {
      const pool = new ApiKeyPool(['k1', 'k2']);
      expect(pool.keyCount).toBe(2);
    });
  });

  describe('acquire', () => {
    it('rotates keys in round-robin order', () => {
      const pool = new ApiKeyPool(['a', 'b', 'c']);
      expect(pool.acquire()).toBe('a');
      expect(pool.acquire()).toBe('b');
      expect(pool.acquire()).toBe('c');
      expect(pool.acquire()).toBe('a');
    });

    it('skips keys in cooldown', () => {
      vi.useFakeTimers();
      const pool = new ApiKeyPool(['a', 'b', 'c']);
      pool.recordFailure('a');
      vi.advanceTimersByTime(10_000);
      // a is still cooling down (30s), so it should be skipped
      expect(pool.acquire()).toBe('b');
      expect(pool.acquire()).toBe('c');
      expect(pool.acquire()).toBe('b'); // a still skipped
    });

    it('resets expired cooldown and returns the key', () => {
      vi.useFakeTimers();
      const pool = new ApiKeyPool(['a', 'b']);
      pool.recordFailure('a');
      vi.advanceTimersByTime(30_001);
      expect(pool.acquire()).toBe('a'); // cooldown expired, key is healthy again
    });

    it('falls back to round-robin when all keys are in cooldown', () => {
      vi.useFakeTimers();
      const pool = new ApiKeyPool(['a', 'b']);
      pool.recordFailure('a');
      pool.recordFailure('b');
      // Both are cooling down, fallback should still return something
      expect(pool.acquire()).toBe('a');
      expect(pool.acquire()).toBe('b');
    });
  });

  describe('recordFailure', () => {
    it('applies 30s cooldown on first failure', () => {
      vi.useFakeTimers();
      const pool = new ApiKeyPool(['a', 'b']);
      pool.recordFailure('a');
      expect(pool.acquire()).toBe('b'); // a skipped
      vi.advanceTimersByTime(30_001);
      expect(pool.acquire()).toBe('a'); // a recovered
    });

    it('applies 5min cooldown on second failure', () => {
      vi.useFakeTimers();
      const pool = new ApiKeyPool(['a', 'b']);
      pool.recordFailure('a');
      pool.recordFailure('a');
      vi.advanceTimersByTime(30_001);
      expect(pool.acquire()).toBe('b'); // a still cooling (5min)
      vi.advanceTimersByTime(300_001);
      expect(pool.acquire()).toBe('a'); // a recovered
    });

    it('applies 30min cooldown on third failure', () => {
      vi.useFakeTimers();
      const pool = new ApiKeyPool(['a', 'b']);
      pool.recordFailure('a');
      pool.recordFailure('a');
      pool.recordFailure('a');
      vi.advanceTimersByTime(300_001);
      expect(pool.acquire()).toBe('b'); // a still cooling (30min)
      vi.advanceTimersByTime(1_800_001);
      expect(pool.acquire()).toBe('a'); // a recovered
    });

    it('is a no-op for unknown keys', () => {
      const pool = new ApiKeyPool(['a']);
      expect(() => pool.recordFailure('unknown')).not.toThrow();
      expect(pool.acquire()).toBe('a');
    });
  });

  describe('resetKey', () => {
    it('clears failure state immediately', () => {
      vi.useFakeTimers();
      const pool = new ApiKeyPool(['a', 'b']);
      pool.recordFailure('a');
      pool.resetKey('a');
      expect(pool.acquire()).toBe('a');
    });

    it('is a no-op for unknown keys', () => {
      const pool = new ApiKeyPool(['a']);
      expect(() => pool.resetKey('unknown')).not.toThrow();
    });
  });
});

/**
 * Scenario: the byte-bounded LRU cache used by the agent blob service.
 *
 * Responsibilities asserted: hit returns the stored value, miss is undefined,
 * least-recently-used eviction on overflow, recency refresh on get, oversize
 * payloads are never cached, replacement re-accounts size, and multiple entries
 * evict to make room. Pure data-structure tests — no DI, no IO.
 *
 * Run: `pnpm test -- test/blob/byteLruCache.test.ts`
 */

import { describe, expect, it } from 'vitest';

import { ByteLruCache } from '#/agent/blob/byteLruCache';

const buf = (n: number): Buffer => Buffer.alloc(n);

describe('ByteLruCache', () => {
  it('returns the stored buffer on a hit', () => {
    const cache = new ByteLruCache(16);
    cache.set('a', Buffer.from('hello'));

    expect(cache.get('a')?.equals(Buffer.from('hello'))).toBe(true);
  });

  it('returns undefined for a missing key', () => {
    const cache = new ByteLruCache(16);

    expect(cache.get('nope')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when capacity is exceeded', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(5));
    cache.set('b', buf(5));

    cache.set('c', buf(5));

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('refreshes recency on get so a read entry survives eviction', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(5));
    cache.set('b', buf(5));

    cache.get('a');
    cache.set('c', buf(5));

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('does not cache a payload larger than maxBytes and keeps existing entries', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(5));

    cache.set('big', buf(11));

    expect(cache.get('big')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
  });

  it('re-accounts size when an existing key is replaced', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(4));
    cache.set('a', buf(9));

    cache.set('b', buf(2));

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
  });

  it('evicts multiple entries to make room for a larger payload', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(3));
    cache.set('b', buf(3));
    cache.set('c', buf(3));

    cache.set('d', buf(5));

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });
});

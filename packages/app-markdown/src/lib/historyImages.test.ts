import { describe, expect, it } from 'vitest';
import { createHistoryImageCache } from './historyImages';

describe('history image reuse', () => {
  it('reuses only successful results for the same content and message', () => {
    const cache = createHistoryImageCache();
    const key = {};
    const results = new Map([['ok.png', 'data:image/png;base64,AA'], ['failed.png', ''], ['missing.png', 'missing.png']]);
    cache.set(key, 'original', results);
    results.set('ok.png', 'changed');
    expect(cache.get(key, 'original')).toEqual(new Map([['ok.png', 'data:image/png;base64,AA']]));
    expect(cache.get({}, 'original')).toBeUndefined();
    expect(cache.get(key, 'edited')).toBeUndefined();
    expect(cache.get(key, 'original')).toBeUndefined();
  });

  it('isolates caches belonging to different conversations', () => {
    const first = createHistoryImageCache();
    const second = createHistoryImageCache();
    const key = {};
    first.set(key, 'body', new Map([['a.png', 'data:image/png;base64,AA']]));
    expect(second.get(key, 'body')).toBeUndefined();
  });

  it('evicts the least recently used content at the image count limit', () => {
    const cache = createHistoryImageCache();
    const keys = Array.from({ length: 129 }, () => ({}));
    for (const key of keys.slice(0, 128)) cache.set(key, 'body', new Map([['a.png', 'data:image/png;base64,AA']]));
    expect(cache.get(keys[0]!, 'body')).toBeDefined();
    cache.set(keys[128]!, 'body', new Map([['b.png', 'data:image/png;base64,BB']]));
    expect(cache.get(keys[0]!, 'body')).toBeDefined();
    expect(cache.get(keys[1]!, 'body')).toBeUndefined();
    expect(cache.get(keys[128]!, 'body')).toBeDefined();
  });

  it('counts multiple images in one message and rejects an oversized group', () => {
    const cache = createHistoryImageCache();
    const first = {};
    const second = {};
    const images = new Map(Array.from({ length: 128 }, (_, i) => [`${i}.png`, `data:image/png;base64,${i}`]));
    cache.set(first, 'body', images);
    cache.set(second, 'body', new Map([['new.png', 'data:image/png;base64,AA']]));
    expect(cache.get(first, 'body')).toBeUndefined();
    images.set('extra.png', 'data:image/png;base64,BB');
    cache.set(first, 'body', images);
    expect(cache.get(first, 'body')).toBeUndefined();
    expect(cache.get(second, 'body')).toBeDefined();
  });

  it('limits retained string bytes and does not charge replaced entries twice', () => {
    const cache = createHistoryImageCache();
    const first = {};
    const second = {};
    const large = 'data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024);
    const images = new Map([['a.png', large]]);
    cache.set(first, 'body', images);
    cache.set(first, 'body', images);
    cache.set(second, 'body', images);
    expect(cache.get(first, 'body')).toBeDefined();
    expect(cache.get(second, 'body')).toBeDefined();
    cache.set({}, 'body', images);
    expect(cache.get(first, 'body')).toBeUndefined();
    expect(cache.get(second, 'body')).toBeDefined();
    cache.set(first, 'body', new Map([['huge.png', large.repeat(3)]]));
    expect(cache.get(first, 'body')).toBeUndefined();
    expect(cache.get(second, 'body')).toBeDefined();
  });
});

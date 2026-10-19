import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getRecommendedEffortConfig,
  peekRecommendedEffortConfig,
  resetRecommendedEffortConfigCache,
} from '#/utils/recommended-effort-config';

const CLOUD_CONFIG = {
  k3: { version: 1757001600, recommended_default_effort: 'max' },
  'k3-256k': { version: 2, recommended_default_effort: 'high' },
};

const ENVELOPE = { name: 'recommended_effort', config: CLOUD_CONFIG };

const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function makeCacheFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'recommended-effort-config-'));
  tempDirs.push(dir);
  return join(dir, 'cache.json');
}

afterEach(async () => {
  resetRecommendedEffortConfigCache();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('getRecommendedEffortConfig', () => {
  it('POSTs the recommended_effort name and returns the per-model entries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    const result = await getRecommendedEffortConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toEqual(CLOUD_CONFIG);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/client_configs'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'recommended_effort' }),
      }),
    );
  });

  it('ignores unknown entry fields so the contract can evolve', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'recommended_effort',
        config: {
          k3: {
            version: 3,
            recommended_default_effort: 'max',
            recommended_current_effort: 'high',
          },
        },
      }),
    );

    const result = await getRecommendedEffortConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toEqual({ k3: { version: 3, recommended_default_effort: 'max' } });
  });

  it('drops only the invalid entries and keeps the valid ones', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'recommended_effort',
        config: {
          valid: { version: 1, recommended_default_effort: 'max' },
          'missing-effort': { version: 1 },
          'missing-version': { recommended_default_effort: 'max' },
          'negative-version': { version: -1, recommended_default_effort: 'max' },
          'fractional-version': { version: 1.5, recommended_default_effort: 'max' },
          'string-version': { version: '1', recommended_default_effort: 'max' },
          'non-string-effort': { version: 1, recommended_default_effort: 5 },
          'not-an-object': 'max',
        },
      }),
    );

    const result = await getRecommendedEffortConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toEqual({ valid: { version: 1, recommended_default_effort: 'max' } });
  });

  it('returns undefined when the envelope name does not match', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: 'survey_popup', config: CLOUD_CONFIG }),
    );

    const result = await getRecommendedEffortConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when the payload is not an object', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: 'recommended_effort', config: 'nope' }),
    );

    const result = await getRecommendedEffortConfig({
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: null,
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when the fetch fails or the response is not ok', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      getRecommendedEffortConfig({ fetchImpl: failing as typeof fetch, cacheFile: null }),
    ).resolves.toBeUndefined();

    const notOk = vi.fn(async () => jsonResponse('no', 503));
    await expect(
      getRecommendedEffortConfig({ fetchImpl: notOk as typeof fetch, cacheFile: null }),
    ).resolves.toBeUndefined();
  });

  it('serves the in-process cache within a day and refetches after it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();

    await getRecommendedEffortConfig({ fetchImpl: fetchImpl as typeof fetch, now, cacheFile: null });
    const cached = await getRecommendedEffortConfig({
      fetchImpl: fetchImpl as typeof fetch,
      now: now + 60_000,
      cacheFile: null,
    });
    expect(cached).toEqual(CLOUD_CONFIG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await getRecommendedEffortConfig({
      fetchImpl: fetchImpl as typeof fetch,
      now: now + 25 * 60 * 60 * 1000,
      cacheFile: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('persists the fetched config to the disk cache for the next process', async () => {
    const cacheFile = await makeCacheFile();
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();

    await getRecommendedEffortConfig({ fetchImpl: fetchImpl as typeof fetch, now, cacheFile });

    const persisted = JSON.parse(await readFile(cacheFile, 'utf-8')) as { config: unknown };
    expect(persisted.config).toEqual(CLOUD_CONFIG);

    resetRecommendedEffortConfigCache();
    const result = await getRecommendedEffortConfig({
      fetchImpl: vi.fn(async () => {
        throw new Error('must not fetch');
      }) as unknown as typeof fetch,
      now: now + 60_000,
      cacheFile,
    });
    expect(result).toEqual(CLOUD_CONFIG);
  });

  it('ignores a stale disk cache and returns undefined when the refetch fails', async () => {
    const cacheFile = await makeCacheFile();
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();

    await getRecommendedEffortConfig({ fetchImpl: fetchImpl as typeof fetch, now, cacheFile });
    resetRecommendedEffortConfigCache();

    const result = await getRecommendedEffortConfig({
      fetchImpl: vi.fn(async () => jsonResponse('no', 503)) as unknown as typeof fetch,
      now: now + 25 * 60 * 60 * 1000,
      cacheFile,
    });
    expect(result).toBeUndefined();
  });
});

describe('peekRecommendedEffortConfig', () => {
  it('returns undefined while the cache is cold', () => {
    expect(peekRecommendedEffortConfig()).toBeUndefined();
  });

  it('sees the fetched config once the cache is warm', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();

    await getRecommendedEffortConfig({ fetchImpl: fetchImpl as typeof fetch, now, cacheFile: null });

    expect(peekRecommendedEffortConfig(now + 60_000)).toEqual(CLOUD_CONFIG);
    expect(peekRecommendedEffortConfig(now + 25 * 60 * 60 * 1000)).toBeUndefined();
  });
});

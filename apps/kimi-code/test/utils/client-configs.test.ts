import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchClientConfig,
  getClientConfig,
  peekClientConfig,
  resetClientConfigCache,
} from '#/utils/client-configs';
import { z } from 'zod';

const configSchema = z.object({
  version: z.literal(1),
  config: z.record(z.string(), z.object({ min_tokens_to_hint: z.number(), cache_duration: z.number() })),
});

const CONFIG = {
  version: 1,
  config: { k3: { min_tokens_to_hint: 200000, cache_duration: 600 } },
};

const ENVELOPE = { name: 'estimated_cache_duration', config: CONFIG };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  resetClientConfigCache();
});

describe('fetchClientConfig', () => {
  it('POSTs the config name and unwraps the envelope', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    const result = await fetchClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toEqual(CONFIG);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/client_configs'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'estimated_cache_duration' }),
      }),
    );
  });

  it('sends the bearer token when provided, anonymous otherwise', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    await fetchClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      accessToken: 'tok',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer tok' }),
      }),
    );

    await fetchClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
      }),
    );
  });

  it('returns undefined on non-OK responses', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('no', 503));

    await expect(
      fetchClientConfig('estimated_cache_duration', configSchema, {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the payload fails the caller schema', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: 'estimated_cache_duration', config: { version: 2, config: {} } }),
    );

    await expect(
      fetchClientConfig('estimated_cache_duration', configSchema, {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the envelope name does not match', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: 'some_other_config', config: CONFIG }),
    );

    await expect(
      fetchClientConfig('estimated_cache_duration', configSchema, {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(
      fetchClientConfig('estimated_cache_duration', configSchema, {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('getClientConfig', () => {
  it('serves the in-process cache within a day', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();

    const first = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now,
      cacheFile: null,
    });
    const second = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now: now + 60_000,
      cacheFile: null,
    });

    expect(first).toEqual(CONFIG);
    expect(second).toEqual(CONFIG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches when the cache is older than a day', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();

    await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now,
      cacheFile: null,
    });
    const result = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now: now + 25 * 60 * 60 * 1000,
      cacheFile: null,
    });

    expect(result).toEqual(CONFIG);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches each config name independently', async () => {
    const other = { name: 'other_config', config: CONFIG };
    const fetchImpl = vi.fn(async (url: unknown, init?: { body?: string }) =>
      jsonResponse(init?.body?.includes('other') ? other : ENVELOPE),
    );
    const now = Date.now();

    await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now,
      cacheFile: null,
    });
    const second = await getClientConfig('other_config', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now,
      cacheFile: null,
    });

    expect(second).toEqual(CONFIG);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('resolves to undefined when the refetch fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('no', 500));

    await expect(
      getClientConfig('estimated_cache_duration', configSchema, {
        fetchImpl: fetchImpl as typeof fetch,
        cacheFile: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('peekClientConfig', () => {
  it('returns the cached config only while fresh', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    const now = Date.now();
    await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now,
      cacheFile: null,
    });

    expect(peekClientConfig('estimated_cache_duration', configSchema, now + 60_000)).toEqual(CONFIG);
    expect(
      peekClientConfig('estimated_cache_duration', configSchema, now + 25 * 60 * 60 * 1000),
    ).toBeUndefined();
  });

  it('returns undefined for a config that was never fetched', () => {
    expect(peekClientConfig('estimated_cache_duration', configSchema)).toBeUndefined();
  });
});

describe('getClientConfig disk cache', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'client-configs-'));
    file = join(dir, 'estimated_cache_duration.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves a fresh disk entry without network and warms the in-process cache', async () => {
    const now = Date.now();
    await writeFile(file, JSON.stringify({ version: 1, fetchedAt: now, config: CONFIG }));
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    const result = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now: now + 60_000,
      cacheFile: file,
    });

    expect(result).toEqual(CONFIG);
    expect(fetchImpl).not.toHaveBeenCalled();
    // The in-process layer was warmed with the original fetch time.
    expect(peekClientConfig('estimated_cache_duration', configSchema, now + 60_000)).toEqual(CONFIG);
  });

  it('serves the disk entry after the in-process cache is dropped (restart)', async () => {
    const now = Date.now();
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));
    await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now,
      cacheFile: file,
    });

    resetClientConfigCache();
    const offline = vi.fn(async (): Promise<Response> => {
      throw new Error('offline');
    });
    const result = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: offline as typeof fetch,
      now: now + 60_000,
      cacheFile: file,
    });

    expect(result).toEqual(CONFIG);
    expect(offline).not.toHaveBeenCalled();
  });

  it('keeps the original fetch time when warming from disk (no TTL extension)', async () => {
    const now = Date.now();
    await writeFile(
      file,
      JSON.stringify({ version: 1, fetchedAt: now - 23 * 60 * 60 * 1000, config: CONFIG }),
    );
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    // 23h old on disk: still fresh.
    await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now,
      cacheFile: file,
    });
    // 2h later (25h since the actual fetch): the warmed entry must be stale.
    expect(peekClientConfig('estimated_cache_duration', configSchema, now + 2 * 60 * 60 * 1000)).toBeUndefined();
  });

  it('refetches and rewrites the file when the disk entry is stale', async () => {
    const now = Date.now();
    await writeFile(
      file,
      JSON.stringify({ version: 1, fetchedAt: now - 25 * 60 * 60 * 1000, config: CONFIG }),
    );
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    const result = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now,
      cacheFile: file,
    });

    expect(result).toEqual(CONFIG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const onDisk = JSON.parse(await readFile(file, 'utf-8')) as { fetchedAt: number };
    expect(onDisk.fetchedAt).toBe(now);
  });

  it('treats a malformed cache file as missing', async () => {
    await writeFile(file, 'not json');
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    const result = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: file,
    });

    expect(result).toEqual(CONFIG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores a disk entry whose payload fails the caller schema', async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 1, fetchedAt: Date.now(), config: { version: 2 } }),
    );
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    const result = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: file,
    });

    expect(result).toEqual(CONFIG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still resolves when the cache file cannot be written', async () => {
    // The parent path is a regular file, so mkdir for the cache file fails.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x');
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    const result = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      cacheFile: join(blocker, 'nested', 'config.json'),
    });

    expect(result).toEqual(CONFIG);
  });
});

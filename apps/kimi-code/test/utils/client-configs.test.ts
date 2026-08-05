import { afterEach, describe, expect, it, vi } from 'vitest';

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
    });
    const second = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now: now + 60_000,
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
    });
    const result = await getClientConfig('estimated_cache_duration', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now: now + 25 * 60 * 60 * 1000,
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
    });
    const second = await getClientConfig('other_config', configSchema, {
      fetchImpl: fetchImpl as typeof fetch,
      now,
    });

    expect(second).toEqual(CONFIG);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('resolves to undefined when the refetch fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('no', 500));

    await expect(
      getClientConfig('estimated_cache_duration', configSchema, {
        fetchImpl: fetchImpl as typeof fetch,
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

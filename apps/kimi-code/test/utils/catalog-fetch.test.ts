import { DEFAULT_CATALOG_URL, CatalogFetchError } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { fetchCatalogOrBuiltIn } from '#/utils/catalog-fetch';

const BUILT_IN = JSON.stringify({
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: { 'claude-test': { id: 'claude-test', limit: { context: 200000 } } },
  },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchCatalogOrBuiltIn', () => {
  it('returns the network catalog when models.dev is reachable', async () => {
    const network = { openai: { id: 'openai', models: {} } };
    const fetchImpl = vi.fn(async () => jsonResponse(network));

    const result = await fetchCatalogOrBuiltIn(DEFAULT_CATALOG_URL, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      builtInJson: BUILT_IN,
    });

    expect(result.fromBuiltIn).toBe(false);
    expect(result.catalog).toEqual(network);
  });

  it('falls back to the built-in snapshot when the default URL fetch fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('no', 503));

    const result = await fetchCatalogOrBuiltIn(DEFAULT_CATALOG_URL, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      builtInJson: BUILT_IN,
    });

    expect(result.fromBuiltIn).toBe(true);
    expect(result.catalog).toEqual(JSON.parse(BUILT_IN));
  });

  it('does not fall back for a custom catalog URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('no', 500));

    await expect(
      fetchCatalogOrBuiltIn('https://example.test/private.json', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        builtInJson: BUILT_IN,
      }),
    ).rejects.toBeInstanceOf(CatalogFetchError);
  });

  it('does not fall back when the caller aborted the request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });

    await expect(
      fetchCatalogOrBuiltIn(DEFAULT_CATALOG_URL, {
        signal: controller.signal,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        builtInJson: BUILT_IN,
      }),
    ).rejects.toThrow();
  });

  it('rethrows when fetch fails and no built-in snapshot is available', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('no', 500));

    await expect(
      fetchCatalogOrBuiltIn(DEFAULT_CATALOG_URL, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        builtInJson: '',
      }),
    ).rejects.toBeInstanceOf(CatalogFetchError);
  });
});

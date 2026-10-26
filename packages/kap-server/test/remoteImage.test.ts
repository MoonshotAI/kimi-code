import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchRemoteImage } from '../src/lib/remoteImage';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function successfulFetch(dispatchers: unknown[]): typeof fetch {
  return async (_input, init) => {
    dispatchers.push((init as { dispatcher?: unknown } | undefined)?.dispatcher);
    return new Response(PNG, { status: 200, headers: { 'content-type': 'text/plain' } });
  };
}

describe('remote image network boundaries', () => {
  beforeEach(() => {
    for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) {
      vi.stubEnv(key, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pins DNS for a direct domain request', async () => {
    const dispatchers: unknown[] = [];
    const hosts: string[] = [];
    const result = await fetchRemoteImage('http://images.example.test/pic.png', {
      lookupImpl: async (host) => {
        hosts.push(host);
        return [{ address: '192.168.1.10', family: 4 }];
      },
      fetchImpl: successfulFetch(dispatchers),
    });

    expect(result.mimeType).toBe('image/png');
    expect(hosts).toEqual(['images.example.test']);
    expect(dispatchers).toHaveLength(1);
    expect(dispatchers[0]).not.toBeUndefined();
  });

  it('uses the global proxy and only pins DNS again for NO_PROXY targets', async () => {
    vi.stubEnv('HTTP_PROXY', 'http://proxy.example.test');
    const dispatchers: unknown[] = [];
    const options = {
      lookupImpl: async () => [{ address: '192.168.1.10', family: 4 as const }],
      fetchImpl: successfulFetch(dispatchers),
    };

    await fetchRemoteImage('http://images.example.test/pic.png', options);
    vi.stubEnv('NO_PROXY', 'images.example.test');
    await fetchRemoteImage('http://images.example.test/pic.png', options);

    expect(dispatchers).toHaveLength(2);
    expect(dispatchers[0]).toBeUndefined();
    expect(dispatchers[1]).not.toBeUndefined();
  });

  it('retains DNS pinning when the proxy does not cover the URL scheme', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test');
    const dispatchers: unknown[] = [];
    const options = {
      lookupImpl: async () => [{ address: '192.168.1.10', family: 4 as const }],
      fetchImpl: successfulFetch(dispatchers),
    };

    await fetchRemoteImage('http://images.example.test/pic.png', options);
    await fetchRemoteImage('https://images.example.test/pic.png', options);

    expect(dispatchers).toHaveLength(2);
    expect(dispatchers[0]).not.toBeUndefined();
    expect(dispatchers[1]).toBeUndefined();
  });

  it('retains DNS pinning when the proxy configuration is invalid', async () => {
    vi.stubEnv('HTTP_PROXY', 'ftp://proxy.example.test');
    const dispatchers: unknown[] = [];
    await fetchRemoteImage('http://images.example.test/pic.png', {
      lookupImpl: async () => [{ address: '192.168.1.10', family: 4 }],
      fetchImpl: successfulFetch(dispatchers),
    });
    expect(dispatchers).toEqual([expect.anything()]);
  });

  it('rejects mixed DNS results before making a request', async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchRemoteImage('http://images.example.test/pic.png', {
        lookupImpl: async () => [
          { address: '192.168.1.10', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
        fetchImpl,
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('includes DNS resolution in the overall timeout budget', async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchRemoteImage('http://images.example.test/pic.png', {
        lookupImpl: () => new Promise(() => undefined),
        fetchImpl,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ kind: 'upstream' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

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
    vi.stubEnv('HTTP_PROXY', '');
    vi.stubEnv('HTTPS_PROXY', '');
    vi.stubEnv('NO_PROXY', '');
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

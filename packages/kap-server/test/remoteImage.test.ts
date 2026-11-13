import { createServer, type AddressInfo } from 'node:net';

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

  it('uses per-target proxy dispatchers and only pins DNS again for NO_PROXY targets', async () => {
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
    expect(dispatchers[0]).not.toBeUndefined();
    expect(dispatchers[1]).not.toBeUndefined();
  });

  it('pins proxied requests to validated addresses and preserves the original host', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test');
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const result = await fetchRemoteImage('https://images.example.test/pic.png', {
      lookupImpl: async () => [{ address: '192.168.1.10', family: 4 as const }],
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(PNG, { status: 200, headers: { 'content-type': 'text/plain' } });
      },
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe('https://192.168.1.10/pic.png');
    expect(calls[0]!.init?.headers).toMatchObject({ host: 'images.example.test' });
    expect((calls[0]!.init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher).not.toBeUndefined();
    expect(result.mimeType).toBe('image/png');
  });

  it('preserves ports and IPv6 brackets in proxied Host headers', async () => {
    vi.stubEnv('HTTP_PROXY', 'http://proxy.example.test');
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const options = {
      lookupImpl: async () => [{ address: '192.168.1.10', family: 4 as const }],
      fetchImpl: async (input: unknown, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(PNG, { status: 200, headers: { 'content-type': 'text/plain' } });
      },
    };

    await fetchRemoteImage('http://images.example.test:8080/pic.png', options);
    await fetchRemoteImage('http://[2001:db8::1]:8080/pic.png', options);

    expect(String(calls[0]!.input)).toBe('http://192.168.1.10:8080/pic.png');
    expect(String(calls[1]!.input)).toBe('http://[2001:db8::1]:8080/pic.png');
    expect(calls[0]!.init?.headers).toMatchObject({ host: 'images.example.test:8080' });
    expect(calls[1]!.init?.headers).toMatchObject({ host: '[2001:db8::1]:8080' });
  });

  it('delivers the original Host authority over a real proxy dispatcher and retries validated addresses', async () => {
    const connectTargets: string[] = [];
    const tunneledHeaders: string[] = [];
    const proxy = createServer((socket) => {
      let buffer = '';
      let tunneled = false;
      socket.on('data', (chunk) => {
        buffer += chunk.toString('latin1');
        while (buffer.includes('\r\n\r\n')) {
          const splitAt = buffer.indexOf('\r\n\r\n');
          const head = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 4);
          if (!tunneled && head.startsWith('CONNECT ')) {
            const target = head.split('\r\n', 1)[0]?.split(' ')[1] ?? '';
            connectTargets.push(target);
            if (target.startsWith('[')) {
              socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
              socket.end();
              return;
            }
            tunneled = true;
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            continue;
          }
          tunneledHeaders.push(head);
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ${PNG.length}\r\nConnection: close\r\n\r\n`,
          );
          socket.end(PNG);
        }
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as AddressInfo).port;
    vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${port}`);
    try {
      const result = await fetchRemoteImage('http://images.example.test:8080/pic.png', {
        lookupImpl: async () => [
          { address: '2001:db8::10', family: 6 },
          { address: '198.51.100.10', family: 4 },
        ],
      });
      expect(result.mimeType).toBe('image/png');
      expect(connectTargets).toEqual(['[2001:db8::10]:8080', '198.51.100.10:8080']);
      expect(tunneledHeaders).toHaveLength(1);
      expect(tunneledHeaders[0]?.toLowerCase()).toContain('\r\nhost: images.example.test:8080\r\n');
    } finally {
      await new Promise<void>((resolve) => {
        proxy.close(() => {
          resolve();
        });
      });
    }
  });

  it('keeps independent dispatchers for direct and proxied schemes', async () => {
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
    expect(dispatchers[1]).not.toBeUndefined();
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

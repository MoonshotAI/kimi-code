/**
 * `web` domain tests — `LocalFetchURLProvider` SSRF guard and redirects.
 *
 * Locks in that the provider rejects URLs whose IP literal or resolved
 * address is private / loopback / link-local (including IPv4-mapped IPv6
 * forms), fails closed on DNS errors, and follows redirects manually with
 * every hop re-validated. DNS is mocked so tests stay hermetic.
 */

import { lookup } from 'node:dns/promises';

import { Agent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const lookupMock = lookup as unknown as Mock;

// The init's dispatcher property is typed by @types/node's bundled
// undici-types, while the runtime value is the undici package's Agent —
// convert through unknown to bridge the two declarations.
function asUndiciAgent(dispatcher: RequestInit['dispatcher']): Agent {
  return dispatcher as unknown as Agent;
}

// Keep DNS hermetic: every hostname resolves to a public address unless a
// test overrides it (mockReset clears per-test overrides first).
beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  // Connection pinning is skipped when a proxy is configured — keep the
  // environment free of proxy variables so tests stay hermetic anywhere.
  for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    vi.stubEnv(key, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function htmlResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('LocalFetchURLProvider SSRF guard', () => {
  it('rejects a loopback IPv4 literal without fetching or resolving DNS', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('http://127.0.0.1:1337/')).rejects.toThrow(
      'Refusing to fetch private address',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects an IPv4-mapped IPv6 literal', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('http://[::ffff:127.0.0.1]/')).rejects.toThrow(
      'Refusing to fetch private address',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects localhost and *.localhost aliases', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('http://localhost:1337/')).rejects.toThrow(
      'Refusing to fetch private host',
    );
    await expect(provider.fetch('http://ev1l.localhost/')).rejects.toThrow(
      'Refusing to fetch private host',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to a loopback address', async () => {
    lookupMock.mockResolvedValue([
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('http://localtest.me/')).rejects.toThrow(
      'resolves to private address',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to an IPv4-mapped IPv6 address', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:169.254.169.254', family: 6 }]);
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('http://sneaky.example.com/')).rejects.toThrow(
      'resolves to private address',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when DNS resolution fails', async () => {
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND b0rked.example'));
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('http://b0rked.example/')).rejects.toThrow('Cannot resolve host');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) schemes before any network access', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('file:///etc/passwd')).rejects.toThrow('Unsupported URL scheme');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches public hosts normally', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/');

    expect(result.content).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith('example.com', { all: true });
  });

  it('skips all checks when allowPrivateAddresses is set', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('local', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl, allowPrivateAddresses: true });

    const result = await provider.fetch('http://127.0.0.1:1337/');

    expect(result.content).toBe('local');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('LocalFetchURLProvider redirects', () => {
  it('follows a redirect after re-validating the target, fetching manually', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/page' },
        }),
      )
      .mockResolvedValueOnce(htmlResponse('final body', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/start');

    expect(result.content).toBe('final body');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(lookupMock).toHaveBeenCalledWith('cdn.example.com', { all: true });
    const [, firstInit] = fetchImpl.mock.calls[0]!;
    expect((firstInit as RequestInit).redirect).toBe('manual');
  });

  it('resolves relative redirect targets against the current URL', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/final' } }))
      .mockResolvedValueOnce(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('https://example.com/start');

    const [secondUrl] = fetchImpl.mock.calls[1]!;
    expect(secondUrl).toBe('https://example.com/final');
  });

  it('refuses a redirect to a private IP literal', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/start')).rejects.toThrow(
      'Refusing to fetch private address',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect whose target host resolves to a private address', async () => {
    lookupMock.mockImplementation(async (host: string) =>
      host === 'internal.example.com'
        ? [{ address: '10.0.0.7', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }],
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://internal.example.com/' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/')).rejects.toThrow(
      'resolves to private address',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after too many redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/loop')).rejects.toThrow(
      'Too many redirects',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(11);
  });

  it('treats a redirect response without a Location header as final', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('odd', { status: 302, headers: { 'content-type': 'text/plain' } }),
      );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/odd');

    expect(result.content).toBe('odd');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('LocalFetchURLProvider connection pinning', () => {
  it('pins a public-host fetch to the addresses validated by the safety check', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/');

    expect(result.content).toBe('ok');
    const [, init] = fetchImpl.mock.calls[0]!;
    const dispatcher = (init as RequestInit).dispatcher;
    expect(dispatcher).toBeInstanceOf(Agent);
    // The DNS answer was validated once and reused for the connection.
    expect(lookupMock).toHaveBeenCalledTimes(1);
    // The per-hop Agent is closed once the body has been consumed.
    expect(asUndiciAgent(dispatcher).closed).toBe(true);
  });

  it('pins every redirect hop to its own validated addresses and closes both Agents', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(htmlResponse('done', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('https://example.com/start');

    const first = (fetchImpl.mock.calls[0]![1] as RequestInit).dispatcher;
    const second = (fetchImpl.mock.calls[1]![1] as RequestInit).dispatcher;
    expect(first).toBeInstanceOf(Agent);
    expect(second).toBeInstanceOf(Agent);
    expect(first).not.toBe(second);
    expect(asUndiciAgent(first).closed).toBe(true);
    expect(asUndiciAgent(second).closed).toBe(true);
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it('passes no dispatcher for an IP literal', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('http://93.184.216.34/');

    expect((fetchImpl.mock.calls[0]![1] as RequestInit).dispatcher).toBeUndefined();
  });

  it('passes no dispatcher when allowPrivateAddresses is set', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl, allowPrivateAddresses: true });

    await provider.fetch('https://example.com/');

    expect((fetchImpl.mock.calls[0]![1] as RequestInit).dispatcher).toBeUndefined();
  });

  it('passes no dispatcher when an HTTP proxy is configured', async () => {
    vi.stubEnv('http_proxy', 'http://proxy.example:8080');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('https://example.com/');

    expect((fetchImpl.mock.calls[0]![1] as RequestInit).dispatcher).toBeUndefined();
  });

  it('still pins when the request bypasses the proxy via NO_PROXY wildcard', async () => {
    vi.stubEnv('http_proxy', 'http://proxy.example:8080');
    vi.stubEnv('no_proxy', '*');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('https://example.com/');

    expect((fetchImpl.mock.calls[0]![1] as RequestInit).dispatcher).toBeInstanceOf(Agent);
  });

  it('still pins when NO_PROXY exempts the target host specifically', async () => {
    vi.stubEnv('http_proxy', 'http://proxy.example:8080');
    vi.stubEnv('no_proxy', 'example.com');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('https://example.com/');

    expect((fetchImpl.mock.calls[0]![1] as RequestInit).dispatcher).toBeInstanceOf(Agent);
  });

  it('rejects oversized responses by content-length and still closes the pinned Agent', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('short', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': String(11 * 1024 * 1024),
        },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/big')).rejects.toThrow(
      'Response body too large',
    );

    const dispatcher = (fetchImpl.mock.calls[0]![1] as RequestInit).dispatcher;
    expect(asUndiciAgent(dispatcher).closed).toBe(true);
  });
});

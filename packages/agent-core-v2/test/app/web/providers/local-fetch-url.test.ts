import { describe, expect, it, vi } from 'vitest';

import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';

function htmlResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('LocalFetchURLProvider requests', () => {
  it('fetches a loopback IPv4 literal', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('local', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('http://127.0.0.1:1337/');

    expect(result.content).toBe('local');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches an IPv4-mapped IPv6 literal', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('local', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('http://[::ffff:127.0.0.1]/');

    expect(result.content).toBe('local');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches localhost and *.localhost aliases', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => htmlResponse('local', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('http://localhost:1337/');
    await provider.fetch('http://app.localhost/');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fetches a hostname without a separate DNS safety check', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('local', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('http://localtest.me/');

    expect(result.content).toBe('local');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localtest.me/',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('propagates fetch network errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('getaddrinfo ENOTFOUND b0rked.example'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('http://b0rked.example/')).rejects.toThrow(
      'getaddrinfo ENOTFOUND b0rked.example',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
  });
});

describe('LocalFetchURLProvider redirects', () => {
  it('follows a redirect manually', async () => {
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

  it('follows a redirect to a private IP literal', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        }),
      )
      .mockResolvedValueOnce(htmlResponse('metadata', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/start');

    expect(result.content).toBe('metadata');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![0]).toBe('http://169.254.169.254/latest/meta-data');
  });

  it('follows a redirect to an internal hostname', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://internal.example.com/' },
        }),
      )
      .mockResolvedValueOnce(htmlResponse('internal', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/');

    expect(result.content).toBe('internal');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

describe('LocalFetchURLProvider responses', () => {
  it('rejects oversized responses by content-length', async () => {
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
  });
});

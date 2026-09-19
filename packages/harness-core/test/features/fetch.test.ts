import { lookup } from 'node:dns/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  createConfig,
  createHarness,
  providerCatalog,
  type ConfigPersist,
  type ToolCall,
} from '@moonshot-ai/agent-core';
import { FileTokenStorage } from '@moonshot-ai/kimi-code-oauth';

import {
  createFetch,
  createFetchURLTool,
  createLocalFetchURLProvider,
  FETCH_URL_MAX_OUTPUT_CHARS,
  HttpFetchError,
  WebFetchRef,
  type UrlFetcher,
  type WebFetchFace,
} from '#/features/kimi/fetch/index';
import { createOauth } from '#/features/kimi/oauth/index';
import { createWeb } from '#/features/kimi/web/index';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const lookupMock = lookup as unknown as Mock;

const homes: string[] = [];

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  for (const key of [
    'http_proxy',
    'HTTP_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
    'no_proxy',
    'NO_PROXY',
    'KIMI_CODE_CUSTOM_HEADERS',
  ]) {
    vi.stubEnv(key, '');
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function setupHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'harness-fetch-'));
  homes.push(home);
  await new FileTokenStorage(join(home, 'credentials')).save('kimi-code', {
    accessToken: 'sk-managed',
    refreshToken: 'refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  });
  return home;
}

function fakePersist(initial?: string): ConfigPersist {
  let text = initial;
  return {
    load: () => Promise.resolve(text),
    save: (value) => {
      text = value;
      return Promise.resolve();
    },
  };
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function stubFetch(handler: (call: FetchCall) => Response): {
  calls: FetchCall[];
  fetchImpl: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const MANAGED_PROVIDER_TOML =
  '[providers."managed:kimi-code"]\n' +
  'type = "kimi"\n' +
  'baseUrl = "https://managed.example.com"\n' +
  'modelSource = "oauth-catalog"\n' +
  'customHeaders = { "X-Custom" = "yes" }\n\n' +
  '[providers."managed:kimi-code".oauth]\n' +
  'storage = "file"\n' +
  'key = "oauth/kimi-code"\n';

const SERVICES_FETCH_TOML =
  '[services.moonshot_fetch]\n' +
  'baseUrl = "https://fetch.example.com/fetch"\n' +
  'apiKey = "sk-fetch"\n';

async function mountFetchApp(
  toml: string | undefined,
  extra: { home?: string; fetchImpl?: typeof fetch } = {},
) {
  const app = createHarness({
    features: [
      createConfig({ persist: fakePersist(toml) }),
      providerCatalog,
      ...(extra.home === undefined ? [] : [createOauth({ home: extra.home })]),
      createWeb({ fetchImpl: extra.fetchImpl }),
      createFetch({ fetchImpl: extra.fetchImpl }),
    ],
  });
  await app.ready();
  return app;
}

function toolCall(url: string): ToolCall {
  return { type: 'function', id: 'call-1', name: 'FetchURL', arguments: JSON.stringify({ url }) };
}

function faceOf(fetcher: UrlFetcher): WebFetchFace {
  return { getUrlFetcher: () => fetcher };
}

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

describe('fetch feature provider resolution', () => {
  it('prefers the services config fetcher over the managed oauth fallback', async () => {
    const home = await setupHome();
    const { calls, fetchImpl } = stubFetch(() => new Response('# fetched', { status: 200 }));
    const app = await mountFetchApp(`${MANAGED_PROVIDER_TOML}\n${SERVICES_FETCH_TOML}`, {
      home,
      fetchImpl,
    });
    const result = await app
      .resolve(WebFetchRef)
      .getUrlFetcher()
      .fetch('https://page.example.com/a', { toolCallId: 'call-1' });
    expect(result).toEqual({ content: '# fetched', kind: 'extracted' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://fetch.example.com/fetch');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-fetch');
    expect(calls[0]?.headers['Accept']).toBe('text/markdown');
    expect(calls[0]?.headers['X-Msh-Tool-Call-Id']).toBe('call-1');
    expect(calls[0]?.body).toBe('{"url":"https://page.example.com/a"}');
    await app.disposeAsync();
  });

  it('falls back to the managed oauth fetcher when the services config has no fetch entry', async () => {
    const home = await setupHome();
    const { calls, fetchImpl } = stubFetch(() => new Response('# fetched', { status: 200 }));
    const app = await mountFetchApp(MANAGED_PROVIDER_TOML, { home, fetchImpl });
    const result = await app
      .resolve(WebFetchRef)
      .getUrlFetcher()
      .fetch('https://page.example.com/a');
    expect(result.kind).toBe('extracted');
    expect(calls[0]?.url).toBe('https://managed.example.com/fetch');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-managed');
    expect(calls[0]?.headers['X-Custom']).toBe('yes');
    await app.disposeAsync();
  });

  it('uses the local fetcher when no moonshot fetch is configured', async () => {
    const { calls, fetchImpl } = stubFetch(
      () => new Response('local body', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const app = await mountFetchApp(undefined, { fetchImpl });
    const result = await app
      .resolve(WebFetchRef)
      .getUrlFetcher()
      .fetch('https://example.com/');
    expect(result).toEqual({ content: 'local body', kind: 'passthrough' });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['User-Agent']).toContain('Chrome/91.0.4472.124');
    await app.disposeAsync();
  });

  it('silently falls back to the local fetcher when the managed fetch fails', async () => {
    const { calls, fetchImpl } = stubFetch((call) =>
      call.method === 'POST'
        ? new Response('server down', { status: 500 })
        : new Response('local body', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const app = await mountFetchApp(SERVICES_FETCH_TOML, { fetchImpl });
    const result = await app
      .resolve(WebFetchRef)
      .getUrlFetcher()
      .fetch('https://page.example.com/a');
    expect(result).toEqual({ content: 'local body', kind: 'passthrough' });
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    await app.disposeAsync();
  });
});

describe('createLocalFetchURLProvider', () => {
  it('passes text/plain and text/markdown bodies through verbatim', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response('# raw markdown', { status: 200, headers: { 'content-type': 'text/markdown' } }),
    );
    const provider = createLocalFetchURLProvider({ fetchImpl });
    const result = await provider.fetch('https://example.com/doc.md');
    expect(result).toEqual({ content: '# raw markdown', kind: 'passthrough' });
  });

  it('extracts the main text from HTML pages with the title prefix', async () => {
    const html =
      '<!doctype html><html><head><title>Example Article</title></head><body>' +
      '<nav>navigation junk</nav>' +
      '<article><h1>Example Article</h1>' +
      '<p>This is the main body of the example article. It carries enough running text, with commas, ' +
      'for the reader to treat the block as meaningful content worth extracting from the page.</p>' +
      '</article></body></html>';
    const { fetchImpl } = stubFetch(
      () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const provider = createLocalFetchURLProvider({ fetchImpl });
    const result = await provider.fetch('https://example.com/article');
    expect(result.kind).toBe('extracted');
    expect(result.content.startsWith('# Example Article')).toBe(true);
    expect(result.content).toContain('main body of the example article');
  });

  it('rejects private addresses and localhost before any network access', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response());
    const provider = createLocalFetchURLProvider({ fetchImpl });
    await expect(provider.fetch('http://127.0.0.1:1337/')).rejects.toThrow(
      'Refusing to fetch private address',
    );
    await expect(provider.fetch('http://[::1]/')).rejects.toThrow(
      'Refusing to fetch private address',
    );
    await expect(provider.fetch('http://localhost:1337/')).rejects.toThrow(
      'Refusing to fetch private host',
    );
    await expect(provider.fetch('http://ev1l.localhost/')).rejects.toThrow(
      'Refusing to fetch private host',
    );
    expect(calls).toHaveLength(0);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects hosts that resolve to private addresses and fails closed on DNS errors', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response());
    const provider = createLocalFetchURLProvider({ fetchImpl });
    lookupMock.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);
    await expect(provider.fetch('http://internal.example.com/')).rejects.toThrow(
      'resolves to private address',
    );
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND b0rked.example'));
    await expect(provider.fetch('http://b0rked.example/')).rejects.toThrow('Cannot resolve host');
    expect(calls).toHaveLength(0);
  });

  it('rejects non-http(s) schemes before any network access', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response());
    const provider = createLocalFetchURLProvider({ fetchImpl });
    await expect(provider.fetch('file:///etc/passwd')).rejects.toThrow('Unsupported URL scheme');
    expect(calls).toHaveLength(0);
  });

  it('follows redirects manually after re-validating each target', async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: '/final' } }),
      new Response('final body', { status: 200, headers: { 'content-type': 'text/plain' } }),
    ];
    const { calls, fetchImpl } = stubFetch(() => responses.shift() ?? new Response());
    const provider = createLocalFetchURLProvider({ fetchImpl });
    const result = await provider.fetch('https://example.com/start');
    expect(result.content).toBe('final body');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://example.com/final');
  });

  it('refuses a redirect to a private address', async () => {
    const { calls, fetchImpl } = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        }),
    );
    const provider = createLocalFetchURLProvider({ fetchImpl });
    await expect(provider.fetch('https://example.com/start')).rejects.toThrow(
      'Refusing to fetch private address',
    );
    expect(calls).toHaveLength(1);
  });

  it('rejects responses larger than maxBytes', async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response('short', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': String(11 * 1024 * 1024),
          },
        }),
    );
    const provider = createLocalFetchURLProvider({ fetchImpl });
    await expect(provider.fetch('https://example.com/big')).rejects.toThrow(
      'Response body too large',
    );
  });

  it('throws HttpFetchError for HTTP error statuses', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response('missing', { status: 404, statusText: 'Not Found' }),
    );
    const provider = createLocalFetchURLProvider({ fetchImpl });
    const error = await provider.fetch('https://example.com/missing').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpFetchError);
    expect((error as HttpFetchError).status).toBe(404);
    expect((error as HttpFetchError).message).toBe('HTTP 404 Not Found');
  });
});

describe('FetchURL tool', () => {
  it('returns the empty-body message', async () => {
    const tool = createFetchURLTool(faceOf({ fetch: () => Promise.resolve({ content: '', kind: 'passthrough' }) }));
    const out = await tool.execute({
      toolCall: toolCall('https://example.com'),
      signal: new AbortController().signal,
    });
    expect(out.content[0]).toEqual({ type: 'text', text: 'The response body is empty.' });
  });

  it('prefixes passthrough and extracted outputs with the note and citation reminder', async () => {
    const run = async (kind: 'passthrough' | 'extracted'): Promise<string> => {
      const tool = createFetchURLTool(
        faceOf({ fetch: () => Promise.resolve({ content: 'BODY', kind }) }),
      );
      const out = await tool.execute({
        toolCall: toolCall('https://example.com'),
        signal: new AbortController().signal,
      });
      const part = out.content[0];
      if (part?.type !== 'text') throw new Error('expected text content');
      return part.text;
    };
    expect(await run('passthrough')).toBe(
      'The returned content is the full response body, returned verbatim. ' +
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).\n\nBODY',
    );
    expect(await run('extracted')).toBe(
      'The returned content is the main text extracted from the page. ' +
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).\n\nBODY',
    );
  });

  it('formats HttpFetchError and network errors as text results', async () => {
    const httpTool = createFetchURLTool(
      faceOf({
        fetch: () => Promise.reject(new HttpFetchError(500, 'Moonshot fetch request failed: HTTP 500.')),
      }),
    );
    const httpOut = await httpTool.execute({
      toolCall: toolCall('https://example.com'),
      signal: new AbortController().signal,
    });
    expect(httpOut.content[0]).toEqual({
      type: 'text',
      text: 'Failed to fetch URL. Status: 500. Moonshot fetch request failed: HTTP 500.',
    });

    const networkTool = createFetchURLTool(
      faceOf({ fetch: () => Promise.reject(new Error('boom')) }),
    );
    const networkOut = await networkTool.execute({
      toolCall: toolCall('https://example.com'),
      signal: new AbortController().signal,
    });
    expect(networkOut.content[0]).toEqual({
      type: 'text',
      text: 'Failed to fetch URL due to network error: https://example.com. boom',
    });
  });

  it('rethrows when the signal is aborted mid-fetch', async () => {
    const controller = new AbortController();
    const tool = createFetchURLTool(
      faceOf({
        fetch: () => {
          controller.abort();
          return Promise.reject(abortError());
        },
      }),
    );
    await expect(
      tool.execute({ toolCall: toolCall('https://example.com'), signal: controller.signal }),
    ).rejects.toThrow('This operation was aborted');
  });

  it('resolves the fetcher per invocation, never at construction', async () => {
    let resolutions = 0;
    const tool = createFetchURLTool({
      getUrlFetcher: () => {
        resolutions += 1;
        return { fetch: () => Promise.resolve({ content: 'ok', kind: 'passthrough' }) };
      },
    });
    expect(resolutions).toBe(0);
    const signal = new AbortController().signal;
    await tool.execute({ toolCall: toolCall('https://example.com'), signal });
    await tool.execute({ toolCall: toolCall('https://example.com'), signal });
    expect(resolutions).toBe(2);
  });

  it('truncates oversized outputs to the retained-character limit', async () => {
    const tool = createFetchURLTool(
      faceOf({
        fetch: () => Promise.resolve({ content: 'x'.repeat(FETCH_URL_MAX_OUTPUT_CHARS + 100), kind: 'passthrough' }),
      }),
    );
    const out = await tool.execute({
      toolCall: toolCall('https://example.com'),
      signal: new AbortController().signal,
    });
    const part = out.content[0];
    if (part?.type !== 'text') throw new Error('expected text content');
    expect(part.text.length).toBe(FETCH_URL_MAX_OUTPUT_CHARS);
  });
});

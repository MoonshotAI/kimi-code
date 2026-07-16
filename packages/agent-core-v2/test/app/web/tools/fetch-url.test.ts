/**
 * FetchURL / LocalFetchURLProvider abort-signal plumbing.
 *
 * Locks in that the `AbortSignal` carried on `ExecutableToolContext` is
 * forwarded all the way to the underlying `fetch` so an in-flight request
 * is actually cancelled (not merely raced by the executor), and that the
 * tool re-throws aborts so the executor can classify user cancellation.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';
import { FetchURLTool } from '#/app/web/tools/fetch-url';
import type { UrlFetcher, UrlFetchResult } from '#/app/web/tools/fetch-url-types';

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function execute(
  tool: FetchURLTool,
  url: string,
  signal: AbortSignal,
): Promise<ExecutableToolResult> {
  const resolved = tool.resolveExecution({ url });
  const execution = isPromiseLike(resolved) ? await resolved : resolved;
  if (execution.isError === true) return execution;
  const ctx: ExecutableToolContext = { turnId: 0, toolCallId: 'call_fetch', signal };
  return execution.execute(ctx);
}

function abortError(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

describe('FetchURLTool abort signal', () => {
  it('forwards ctx.signal to the fetcher', async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn<UrlFetcher['fetch']>()
      .mockResolvedValue({ content: 'hello', kind: 'passthrough' } satisfies UrlFetchResult);
    const tool = new FetchURLTool({ fetch });

    await execute(tool, 'https://example.com', controller.signal);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = fetch.mock.calls[0]!;
    expect(options?.toolCallId).toBe('call_fetch');
    expect(options?.signal).toBe(controller.signal);
  });

  it('re-throws when the signal aborts mid-fetch', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<UrlFetcher['fetch']>().mockImplementation(async () => {
      controller.abort(new Error('Aborted by the user'));
      throw abortError();
    });
    const tool = new FetchURLTool({ fetch });

    await expect(execute(tool, 'https://example.com', controller.signal)).rejects.toThrow();
  });

  it('returns a normal error result when fetch fails without abort', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<UrlFetcher['fetch']>().mockRejectedValue(new Error('boom'));
    const tool = new FetchURLTool({ fetch });

    const result = await execute(tool, 'https://example.com', controller.signal);

    expect(result.isError).toBe(true);
    if (typeof result.output !== 'string') {
      throw new Error('expected string error output');
    }
    expect(result.output).toContain('boom');
  });

  it('returns an error result when fetch throws a non-Error value', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<UrlFetcher['fetch']>().mockRejectedValue('string error');
    const tool = new FetchURLTool({ fetch });

    const result = await execute(tool, 'https://example.com', controller.signal);

    expect(result.isError).toBe(true);
    if (typeof result.output !== 'string') throw new Error('expected string');
    expect(result.output).toContain('string error');
  });

  it('returns an error result when the URL is invalid', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<UrlFetcher['fetch']>().mockRejectedValue(new Error('Invalid URL'));
    const tool = new FetchURLTool({ fetch });

    const result = await execute(tool, 'not-a-valid-url', controller.signal);

    expect(result.isError).toBe(true);
    if (typeof result.output !== 'string') throw new Error('expected string');
    expect(result.output).toContain('Invalid URL');
  });

  it('returns an empty-content result when fetcher returns empty content', async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn<UrlFetcher['fetch']>()
      .mockResolvedValue({ content: '', kind: 'passthrough' } satisfies UrlFetchResult);
    const tool = new FetchURLTool({ fetch });

    const result = await execute(tool, 'https://example.com', controller.signal);

    expect(result.isError).toBe(false);
    if (typeof result.output !== 'string') throw new Error('expected string');
    expect(result.output).toBe('The response body is empty.');
  });

  it('returns an error with HttpFetchError code and status', async () => {
    const controller = new AbortController();
    const { HttpFetchError } = await import('#/app/web/tools/fetch-url-types');
    const fetch = vi.fn<UrlFetcher['fetch']>().mockRejectedValue(
      new HttpFetchError(403, 'Forbidden'),
    );
    const tool = new FetchURLTool({ fetch });

    const result = await execute(tool, 'https://example.com', controller.signal);

    expect(result.isError).toBe(true);
    if (typeof result.output !== 'string') throw new Error('expected string');
    expect(result.output).toContain('Status: 403');
    expect(result.output).toContain('Forbidden');
  });

  it('resolveExecution returns a short preview for a long URL', () => {
    const fetch = vi.fn<UrlFetcher['fetch']>();
    const tool = new FetchURLTool({ fetch });
    const longUrl = 'https://example.com/' + 'a'.repeat(100);
    const execution = tool.resolveExecution({ url: longUrl });
    expect(execution.description).toBe('Fetching: ' + longUrl.slice(0, 50) + '…');
  });

  it('resolveExecution returns a direct preview for a short URL', () => {
    const fetch = vi.fn<UrlFetcher['fetch']>();
    const tool = new FetchURLTool({ fetch });
    const execution = tool.resolveExecution({ url: 'https://short.url' });
    expect(execution.description).toBe('Fetching: https://short.url');
  });
});

describe('FetchURLTool output note', () => {
  async function runKind(kind: UrlFetchResult['kind']): Promise<string> {
    const fetch = vi
      .fn<UrlFetcher['fetch']>()
      .mockResolvedValue({ content: 'BODY', kind } satisfies UrlFetchResult);
    const tool = new FetchURLTool({ fetch });
    const result = await execute(tool, 'https://example.com', new AbortController().signal);
    expect(result.isError).toBe(false);
    if (typeof result.output !== 'string') throw new Error('expected string output');
    return result.output;
  }

  it('puts the passthrough note and citation reminder at the front of output', async () => {
    const output = await runKind('passthrough');
    expect(output).toBe(
      'The returned content is the full response body, returned verbatim. ' +
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).\n\nBODY',
    );
  });

  it('puts the extracted note and citation reminder at the front of output', async () => {
    const output = await runKind('extracted');
    expect(output).toBe(
      'The returned content is the main text extracted from the page. ' +
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).\n\nBODY',
    );
  });
});

describe('LocalFetchURLProvider abort signal', () => {
  it('passes the signal through to fetchImpl', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('plain text', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('https://example.com/test', { signal: controller.signal });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit | undefined)?.signal).toBe(controller.signal);
  });

  it('throws on private IP addresses by default', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('http://127.0.0.1:8080/secret')).rejects.toThrow(
      'Refusing to fetch private',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on localhost by default', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('http://localhost:3000/')).rejects.toThrow(
      'Refusing to fetch private host',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on unsupported URL scheme', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('ftp://files.example.com/readme')).rejects.toThrow(
      'Unsupported URL scheme',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a malformed URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('not a valid url at all')).rejects.toThrow('Invalid URL');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on 400+ status codes as HttpFetchError', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('Not Found', {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/missing')).rejects.toThrow(
      'HTTP 404 Not Found',
    );
  });

  it('throws on content-length exceeding maxBytes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('x'.repeat(100), {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': String(11 * 1024 * 1024),
        },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl, maxBytes: 1024 * 1024 });

    await expect(provider.fetch('https://example.com/large')).rejects.toThrow(
      'exceeds maxBytes',
    );
  });

  it('allows private addresses when allowPrivateAddresses is true', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('local', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl, allowPrivateAddresses: true });

    const result = await provider.fetch('http://127.0.0.1:8080/health', {});
    expect(result.content).toBe('local');
  });
});

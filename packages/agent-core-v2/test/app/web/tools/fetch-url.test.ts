import { lookup } from 'node:dns/promises';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';
import { FetchURLTool } from '#/agent/tools/fetch-url/fetchUrlTool';
import type { UrlFetcher, UrlFetchResult } from '#/app/web/tools/fetch-url-types';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

beforeEach(() => {
  (lookup as unknown as Mock).mockReset();
  (lookup as unknown as Mock).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

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
  it('passes a live deadline signal to the fetcher', async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn<UrlFetcher['fetch']>()
      .mockResolvedValue({ content: 'hello', kind: 'passthrough' } satisfies UrlFetchResult);
    const tool = new FetchURLTool({
      _serviceBrand: undefined,
      getUrlFetcher: () => ({ fetch }),
    });

    await execute(tool, 'https://example.com', controller.signal);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = fetch.mock.calls[0]!;
    expect(options?.toolCallId).toBe('call_fetch');
    expect(options?.signal).not.toBe(controller.signal);
    expect(options?.signal?.aborted).toBe(false);
  });

  it('re-throws when the signal aborts mid-fetch', async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const fetch = vi.fn<UrlFetcher['fetch']>().mockImplementation(async (_url, options) => {
      fetchSignal = options?.signal;
      controller.abort(new Error('Aborted by the user'));
      throw abortError();
    });
    const tool = new FetchURLTool({
      _serviceBrand: undefined,
      getUrlFetcher: () => ({ fetch }),
    });

    await expect(execute(tool, 'https://example.com', controller.signal)).rejects.toThrow();
    expect(fetchSignal?.aborted).toBe(true);
  });

  it('returns a normal error result when fetch fails without abort', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<UrlFetcher['fetch']>().mockRejectedValue(new Error('boom'));
    const tool = new FetchURLTool({
      _serviceBrand: undefined,
      getUrlFetcher: () => ({ fetch }),
    });

    const result = await execute(tool, 'https://example.com', controller.signal);

    expect(result.isError).toBe(true);
    if (typeof result.output !== 'string') {
      throw new Error('expected string error output');
    }
    expect(result.output).toContain('boom');
  });
});

describe('FetchURLTool default timeout', () => {
  it('returns a timeout error after 30 seconds when the fetcher never settles', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let fetchSignal: AbortSignal | undefined;
      const fetch = vi.fn<UrlFetcher['fetch']>().mockImplementation(
        async (_url, options) => {
          fetchSignal = options?.signal;
          return new Promise<UrlFetchResult>(() => {});
        },
      );
      const tool = new FetchURLTool({
        _serviceBrand: undefined,
        getUrlFetcher: () => ({ fetch }),
      });
      let settled = false;
      const pending = execute(tool, 'https://example.com', controller.signal).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      expect(fetchSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const result = await pending;
      expect(result.isError).toBe(true);
      if (typeof result.output !== 'string') throw new Error('expected string error output');
      expect(result.output).toContain('timed out after 30 seconds');
      expect(fetchSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FetchURLTool output note', () => {
  async function runKind(kind: UrlFetchResult['kind']): Promise<string> {
    const fetch = vi
      .fn<UrlFetcher['fetch']>()
      .mockResolvedValue({ content: 'BODY', kind } satisfies UrlFetchResult);
    const tool = new FetchURLTool({
      _serviceBrand: undefined,
      getUrlFetcher: () => ({ fetch }),
    });
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

describe('FetchURLTool backend resolution', () => {
  it('resolves the fetcher per invocation, never at construction', async () => {
    const fetch = vi
      .fn<UrlFetcher['fetch']>()
      .mockResolvedValue({ content: 'hello', kind: 'passthrough' } satisfies UrlFetchResult);
    const getUrlFetcher = vi.fn(() => ({ fetch }));
    const tool = new FetchURLTool({ _serviceBrand: undefined, getUrlFetcher });

    expect(getUrlFetcher).not.toHaveBeenCalled();

    await execute(tool, 'https://example.com', new AbortController().signal);
    await execute(tool, 'https://example.com', new AbortController().signal);
    expect(getUrlFetcher).toHaveBeenCalledTimes(2);
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
});

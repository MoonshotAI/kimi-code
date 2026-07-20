/**
 * FetchURL / LocalFetchURLProvider abort-signal plumbing.
 *
 * Locks in that the `AbortSignal` carried on `ExecutableToolContext` is
 * forwarded all the way to the underlying `fetch` so an in-flight request
 * is actually cancelled (not merely raced by the executor), and that the
 * tool re-throws aborts so the executor can classify user cancellation.
 */

import { lookup } from 'node:dns/promises';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';
import { FetchURLTool } from '#/app/web/tools/fetch-url';
import type { UrlFetcher, UrlFetchResult } from '#/app/web/tools/fetch-url-types';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

// LocalFetchURLProvider resolves hostnames before fetching; keep DNS
// hermetic so provider-level tests never touch the real resolver.
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
});

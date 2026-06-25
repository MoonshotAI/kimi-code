/**
 * Covers: FetchURLTool.
 *
 * Uses a fake UrlFetcher to test tool behaviour in isolation.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  FetchURLInputSchema,
  FetchURLTool,
  HttpFetchError,
  type UrlFetcher,
} from '../../src/tools/builtin/web/fetch-url';
import { MoonshotFetchURLProvider } from '../../src/tools/providers/moonshot-fetch-url';
import { toolContentString } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function fakeFetcher(
  content = '',
  kind: 'passthrough' | 'extracted' = 'extracted',
): UrlFetcher {
  return { fetch: vi.fn().mockResolvedValue({ content, kind }) };
}

describe('FetchURLTool', () => {
  it('has name "FetchURL" and a non-empty description', () => {
    const tool = new FetchURLTool(fakeFetcher());
    expect(tool.name).toBe('FetchURL');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('parameters are generated from the current input schema', () => {
    const tool = new FetchURLTool(fakeFetcher());
    expect(FetchURLInputSchema.safeParse({ url: 'https://example.com' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
    });
  });

  it('does not expose a "format" parameter in its JSON Schema', () => {
    const tool = new FetchURLTool(fakeFetcher());
    const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
    expect(properties).toBeDefined();
    expect(properties).not.toHaveProperty('format');
  });

  it('returns fetched content from provider', async () => {
    const tool = new FetchURLTool(fakeFetcher('Hello, world!'));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c1',
      args: { url: 'https://example.com' },
      signal,
    });
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toBe('Hello, world!');
  });

  it('reports an extraction-specific message for extracted content', async () => {
    const tool = new FetchURLTool(fakeFetcher('Article body', 'extracted'));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-extracted',
      args: { url: 'https://example.com/article' },
      signal,
    });
    expect(result.isError).toBe(false);
    expect((result as { message?: string }).message).toBe(
      'The returned content is the main text extracted from the page.',
    );
  });

  it('reports a passthrough-specific message for verbatim content', async () => {
    const tool = new FetchURLTool(fakeFetcher('# Raw markdown', 'passthrough'));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-passthrough',
      args: { url: 'https://example.com/readme.md' },
      signal,
    });
    expect(result.isError).toBe(false);
    expect((result as { message?: string }).message).toBe(
      'The returned content is the full response body, returned verbatim.',
    );
  });

  it('returns empty message when fetcher returns empty string', async () => {
    const tool = new FetchURLTool(fakeFetcher(''));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c2',
      args: { url: 'https://example.com/empty' },
      signal,
    });
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('empty');
  });

  it('truncates oversized fetched content through the shared builder', async () => {
    const tool = new FetchURLTool(fakeFetcher('x'.repeat(60_000)));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-large',
      args: { url: 'https://example.com/large' },
      signal,
    });

    const content = toolContentString(result);
    expect(result.isError).toBe(false);
    expect(content).toContain('[...truncated]');
    expect(content).toContain('Output is truncated');
    expect(content.length).toBeLessThan(60_000);
    expect((result as { message?: string }).message).toContain('Output is truncated');
  });

  it('returns error when fetcher throws', async () => {
    const fetcher: UrlFetcher = {
      fetch: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const tool = new FetchURLTool(fetcher);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c3',
      args: { url: 'https://example.com/fail' },
      signal,
    });
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('timeout');
  });

  it('passes the tool call id and abort signal to the fetcher', async () => {
    const fetcher = fakeFetcher('content');
    const tool = new FetchURLTool(fetcher);
    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c4',
      args: { url: 'https://example.com' },
      signal,
    });
    expect(fetcher.fetch).toHaveBeenCalledWith('https://example.com', {
      toolCallId: 'c4',
      signal,
    });
  });

  it('resolveExecution description truncates long URLs', () => {
    const tool = new FetchURLTool(fakeFetcher());
    const execution = tool.resolveExecution({ url: 'https://example.com/' + 'a'.repeat(60) });
    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    const desc = execution.description;
    const text = desc ?? '';
    expect(text.length).toBeLessThanOrEqual(65);
    expect(text).toContain('…');
  });

  it('description names URL fetching as the tool surface', () => {
    const tool = new FetchURLTool(fakeFetcher());
    expect(tool.description).toContain('URL');
    expect(tool.description.toLowerCase()).toContain('fetch');
  });

  it('extracts visible article text and metadata from an HTML page, stripping tags', async () => {
    // The host provider is responsible for HTML→text extraction. Lock down
    // that when the fetcher returns trafilatura-style cleaned text, the tool
    // forwards it verbatim and keeps the meaningful tokens (no raw tags).
    const extracted = [
      'title: Sample Bug Report',
      'description: The default value should be lowercase.',
      '',
      'Sample Bug Report',
      'The default parameter value for optimizer should probably be adamw instead of adamW.',
    ].join('\n');
    const tool = new FetchURLTool(fakeFetcher(extracted));

    const result = await executeTool(tool,{
      turnId: 't1',
      toolCallId: 'c_html',
      args: { url: 'https://example.com/bug' },
      signal,
    });

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('optimizer');
    expect(content).toContain('adamw');
    expect(content).toContain('adamW');
    expect(content).not.toContain('<article>');
    expect(content).not.toContain('<code>');
    expect(content.toLowerCase()).toContain('title:');
    expect(content.toLowerCase()).toContain('description:');
  });

  it('surfaces HTTP status in the error message for 404 responses', async () => {
    // py contract: "Failed to fetch URL. Status: 404. ..." Fetcher signals
    // the HTTP status via a typed HttpFetchError; tool renders Status: N.
    const fetcher: UrlFetcher = {
      fetch: vi.fn().mockRejectedValue(new HttpFetchError(404, 'Not Found')),
    };
    const tool = new FetchURLTool(fetcher);

    const result = await executeTool(tool,{
      turnId: 't1',
      toolCallId: 'c_404',
      args: { url: 'https://example.com/missing' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Status: 404');
  });

  it('reports the empty URL verbatim in the error message', async () => {
    // py renders: "Failed to fetch URL due to network error: . ..." with the
    // empty URL surfaced where the URL would normally go.
    const fetcher: UrlFetcher = {
      fetch: vi.fn().mockRejectedValue(new Error('network error: ')),
    };
    const tool = new FetchURLTool(fetcher);

    const result = await executeTool(tool,{
      turnId: 't1',
      toolCallId: 'c_empty',
      args: { url: '' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toMatch(/due to network error/i);
  });

  it('passes through markdown content verbatim instead of running text extraction', async () => {
    // py: when the server returns text/markdown, extraction is skipped and
    // the body is returned as-is with a different status message. The
    // fetcher signals the bypass via UrlFetchResult.kind = 'passthrough'.
    const markdown = '# Title\n\nThis is a markdown document.\n';
    const fetcher: UrlFetcher = {
      fetch: vi.fn().mockResolvedValue({ content: markdown, kind: 'passthrough' }),
    };
    const tool = new FetchURLTool(fetcher);

    const result = await executeTool(tool,{
      turnId: 't1',
      toolCallId: 'c_md',
      args: { url: 'https://example.com/page.md' },
      signal,
    });

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toBe(markdown);
    // The passthrough message says the LLM is seeing the full response
    // body (py wording was "full content"; main #238 uses the broader
    // "full response body" phrasing).
    const message = (result as { message?: string }).message ?? '';
    expect(message).toContain('full response body');
  });
});

describe('MoonshotFetchURLProvider', () => {
  it('does not force-refresh request auth after a 401 response', async () => {
    const getAccessToken = vi.fn().mockResolvedValue('fresh-token');
    const localFallback = fakeFetcher('fallback content');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const provider = new MoonshotFetchURLProvider({
      tokenProvider: { getAccessToken },
      baseUrl: 'https://fetch.example/v1',
      localFallback,
      fetchImpl,
    });

    await expect(provider.fetch('https://example.com/page')).resolves.toEqual({
      content: 'fallback content',
      kind: 'extracted',
    });

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledWith();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(localFallback.fetch).toHaveBeenCalledWith('https://example.com/page', {});
  });
});

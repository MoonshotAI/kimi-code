/**
 * Covers: WebSearchTool.
 *
 * Uses a fake WebSearchProvider to test tool behaviour in isolation.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  WebSearchInputSchema,
  WebSearchTool,
  type WebSearchProvider,
} from '../../src/tools/builtin/web/web-search';
import { MoonshotWebSearchProvider } from '../../src/tools/providers/moonshot-web-search';
import { toolContentString } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function fakeProvider(
  results: Awaited<ReturnType<WebSearchProvider['search']>> = [],
): WebSearchProvider {
  return { search: vi.fn().mockResolvedValue(results) };
}

describe('WebSearchTool', () => {
  it('has name "WebSearch" and a non-empty description', () => {
    const tool = new WebSearchTool(fakeProvider());
    expect(tool.name).toBe('WebSearch');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('parameters are generated from the current input schema', () => {
    const tool = new WebSearchTool(fakeProvider());
    expect(WebSearchInputSchema.safeParse({ query: 'test' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    });
  });

  it('parameters expose only the query field', () => {
    const tool = new WebSearchTool(fakeProvider());
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(['query']);
  });

  it('returns formatted results from provider', async () => {
    const provider = fakeProvider([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet 2', date: '2024-01-01' },
    ]);
    const tool = new WebSearchTool(provider);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c1',
      args: { query: 'test query' },
      signal,
    });
    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('Result 1');
    expect(content).toContain('https://example.com/1');
    expect(content).toContain('Result 2');
    expect(content).toContain('2024-01-01');
  });

  it('renders the snippet under a "Snippet:" label consistent with the schema term', async () => {
    const provider = fakeProvider([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
    ]);
    const tool = new WebSearchTool(provider);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-snippet',
      args: { query: 'test query' },
      signal,
    });
    const content = toolContentString(result);
    expect(content).toContain('Snippet: Snippet 1');
    expect(content).not.toContain('Summary:');
  });

  it('describes the returned fields and points to FetchURL for full pages', () => {
    const tool = new WebSearchTool(fakeProvider());
    const description = tool.description.toLowerCase();
    expect(description).toContain('title');
    expect(description).toContain('url');
    expect(description).toContain('snippet');
    expect(description).toContain('date');
    expect(description).toContain('site');
    expect(description).toContain('fetchurl');
  });

  it('frames results as summaries rather than inlined full pages', () => {
    // Search results no longer carry page content; full content is fetched on
    // demand via FetchURL. The description must not claim full content is
    // inlined for every result.
    const tool = new WebSearchTool(fakeProvider());
    const description = tool.description.toLowerCase();
    expect(description).not.toContain('for each result');
    expect(description).toContain('summaries');
  });

  it('instructs the model to cite source URLs in its description', () => {
    const tool = new WebSearchTool(fakeProvider());
    const description = tool.description.toLowerCase();
    expect(description).toContain('cite');
    expect(description).toContain('source');
  });

  it('renders the source site when the provider returns it', async () => {
    const provider = fakeProvider([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1', siteName: 'Example Co' },
    ]);
    const tool = new WebSearchTool(provider);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-site',
      args: { query: 'test query' },
      signal,
    });
    expect(toolContentString(result)).toContain('Site: Example Co');
  });

  it('appends a citation reminder after the results', async () => {
    const provider = fakeProvider([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
    ]);
    const tool = new WebSearchTool(provider);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-cite',
      args: { query: 'test query' },
      signal,
    });
    const content = toolContentString(result);
    expect(content).toContain('cite');
    expect(content).toContain('[title](url)');
  });

  it('does not append the citation reminder when there are no results', async () => {
    const tool = new WebSearchTool(fakeProvider([]));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-cite-empty',
      args: { query: 'nothing' },
      signal,
    });
    expect(toolContentString(result)).not.toContain('[title](url)');
  });

  it('returns no results message when provider returns empty', async () => {
    const tool = new WebSearchTool(fakeProvider([]));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c2',
      args: { query: 'nothing' },
      signal,
    });
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('No search results found');
  });

  it('truncates oversized result content through the shared builder', async () => {
    const tool = new WebSearchTool(
      fakeProvider([
        {
          title: 'Large result',
          url: 'https://example.com/large',
          snippet: 'x'.repeat(60_000),
        },
      ]),
    );

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-large',
      args: { query: 'large' },
      signal,
    });

    const content = toolContentString(result);
    expect(result.isError).toBe(false);
    expect(content).toContain('[...truncated]');
    expect(content).toContain('Output is truncated');
    expect(content.length).toBeLessThan(60_000);
    expect((result as { message?: string }).message).toContain('Output is truncated');
  });

  it('returns error when provider throws', async () => {
    const provider: WebSearchProvider = {
      search: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const tool = new WebSearchTool(provider);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c3',
      args: { query: 'fail' },
      signal,
    });
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('network error');
  });

  it('classifies authentication failures', async () => {
    const provider: WebSearchProvider = {
      search: vi
        .fn()
        .mockRejectedValue(
          new Error('Moonshot search request failed: HTTP 401 (auth/unauthorized).'),
        ),
    };
    const tool = new WebSearchTool(provider);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-auth',
      args: { query: 'fail' },
      signal,
    });
    expect(result.isError).toBe(true);
    const content = toolContentString(result);
    // Assert the classification prefix, not text that already appears in the raw error.
    expect(content).toContain('Search failed (authentication):');
    // The original error text is preserved alongside the prefix.
    expect(content).toContain('HTTP 401');
  });

  it('classifies timeout failures', async () => {
    const err = new Error('request timed out');
    err.name = 'TimeoutError';
    const provider: WebSearchProvider = { search: vi.fn().mockRejectedValue(err) };
    const tool = new WebSearchTool(provider);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-timeout',
      args: { query: 'fail' },
      signal,
    });
    expect(result.isError).toBe(true);
    const content = toolContentString(result);
    // Assert the classification prefix, which does not overlap with the raw error text.
    expect(content).toContain('Search timed out:');
    // The original error text is preserved alongside the prefix.
    expect(content).toContain('request timed out');
  });

  it('classifies aborted requests', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const provider: WebSearchProvider = { search: vi.fn().mockRejectedValue(err) };
    const tool = new WebSearchTool(provider);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-abort',
      args: { query: 'fail' },
      signal,
    });
    expect(result.isError).toBe(true);
    const content = toolContentString(result);
    // Assert the classification prefix, not text that already appears in the raw error.
    expect(content).toContain('Search cancelled:');
    // The original error text is preserved alongside the prefix.
    expect(content).toContain('The operation was aborted');
  });

  it('passes only the query and toolCallId to the provider', async () => {
    const provider = fakeProvider([]);
    const tool = new WebSearchTool(provider);
    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c4',
      args: { query: 'test' },
      signal,
    });
    expect(provider.search).toHaveBeenCalledWith('test', {
      toolCallId: 'c4',
    });
  });

  it('resolveExecution description truncates long queries', () => {
    const tool = new WebSearchTool(fakeProvider());
    const execution = tool.resolveExecution({ query: 'a'.repeat(60) });
    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    const desc = execution.description;
    const text = desc ?? '';
    expect(text.length).toBeLessThanOrEqual(55);
    expect(text).toContain('…');
  });

  it('description names internet search as the tool surface', () => {
    const tool = new WebSearchTool(fakeProvider());
    expect(tool.description.toLowerCase()).toMatch(/internet|search the web/);
    expect(tool.description.toLowerCase()).toContain('search');
  });
});

describe('MoonshotWebSearchProvider', () => {
  it('maps site_name to siteName and does not forward page content', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          search_results: [
            {
              title: 'T',
              url: 'https://e.com',
              snippet: 'S',
              site_name: 'E Co',
              date: '2026-01-01',
              content: 'FULL PAGE BODY',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = new MoonshotWebSearchProvider({
      apiKey: 'k',
      baseUrl: 'https://search.example/v1',
      fetchImpl,
    });

    const [r] = await provider.search('q');

    expect(r).toEqual({
      title: 'T',
      url: 'https://e.com',
      snippet: 'S',
      siteName: 'E Co',
      date: '2026-01-01',
    });
    expect(r).not.toHaveProperty('content');
  });

  it('sends only text_query in the request body (no limit/crawling/timeout)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ search_results: [] }), { status: 200 }),
      );
    const provider = new MoonshotWebSearchProvider({
      apiKey: 'k',
      baseUrl: 'https://search.example/v1',
      fetchImpl,
    });

    await provider.search('hello');

    const sent = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(String(sent))).toEqual({ text_query: 'hello' });
  });

  it('does not force-refresh request auth after a 401 response', async () => {
    const getAccessToken = vi.fn().mockResolvedValue('fresh-token');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const provider = new MoonshotWebSearchProvider({
      tokenProvider: { getAccessToken },
      baseUrl: 'https://search.example/v1',
      fetchImpl,
    });

    await expect(provider.search('query')).rejects.toThrow(/HTTP 401/);

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledWith();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer fresh-token',
    });
  });
});

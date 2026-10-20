import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import type { WebSearchFace, WebSearchResult } from './provider';
import DESCRIPTION from './web-search.md?raw';

export const WEB_SEARCH_TOOL_NAME = 'WebSearch';

export const WEB_SEARCH_PROVIDER_REMOVED_MESSAGE =
  'Web search is no longer configured; the provider was removed after this session started.';

export function createWebSearchTool(web: WebSearchFace): ToolDefinition {
  return {
    name: WEB_SEARCH_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The query text to search for.' },
      },
      required: ['query'],
    },
    async execute({ toolCall, signal }) {
      const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
      const errorText = (value: string) => ({
        content: [{ type: 'text' as const, text: value }],
        isError: true as const,
      });
      const provider = web.getProvider();
      if (provider === undefined) return errorText(WEB_SEARCH_PROVIDER_REMOVED_MESSAGE);
      const args = JSON.parse(toolCall.arguments ?? '{}') as { query?: unknown };
      const query = typeof args.query === 'string' ? args.query : '';
      try {
        const results = await provider.search(query, { toolCallId: toolCall.id, signal });
        return text(formatSearchResults(results));
      } catch (error) {
        if (signal.aborted) throw error;
        return errorText(classifySearchError(error));
      }
    },
  };
}

export function formatSearchResults(results: readonly WebSearchResult[]): string {
  if (results.length === 0) return 'No search results found.';
  const blocks = results.map((result) => {
    let block = `Title: ${result.title}\n`;
    if (result.siteName !== undefined) block += `Site: ${result.siteName}\n`;
    if (result.date !== undefined) block += `Date: ${result.date}\n`;
    block += `URL: ${result.url}\n`;
    block += `Snippet: ${result.snippet}\n\n`;
    return block;
  });
  return (
    blocks.join('---\n\n') +
    'When you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).'
  );
}

export function classifySearchError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (name === 'AbortError' || lower.includes('abort')) {
    return `Search cancelled: ${message}`;
  }
  if (name === 'TimeoutError' || lower.includes('timed out') || lower.includes('timeout')) {
    return `Search timed out: ${message}`;
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return `Search failed (authentication): ${message}`;
  }
  if (
    lower.includes('http ') ||
    lower.includes('network') ||
    lower.includes('fetch') ||
    name === 'TypeError'
  ) {
    return `Search failed (network): ${message}`;
  }
  return `Search failed: ${message}`;
}

import type { ToolDefinition } from '@moonshot-ai/agent-core';

import { HttpFetchError } from './fetcher';
import type { WebFetchFace } from './feature';
import DESCRIPTION from './fetch-url.md?raw';

export const FETCH_URL_TOOL_NAME = 'FetchURL';

export const FETCH_URL_MAX_OUTPUT_CHARS = 10_000_000;

export function createFetchURLTool(webFetch: WebFetchFace): ToolDefinition {
  return {
    name: FETCH_URL_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch content from.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute({ toolCall, signal }) {
      const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
      const errorText = (value: string) => ({
        content: [{ type: 'text' as const, text: value }],
        isError: true as const,
      });
      const args = JSON.parse(toolCall.arguments ?? '{}') as { url?: unknown };
      const url = typeof args.url === 'string' ? args.url : '';
      try {
        const { content, kind } = await webFetch
          .getUrlFetcher()
          .fetch(url, { toolCallId: toolCall.id, signal });
        if (!content) return text('The response body is empty.');
        const note =
          kind === 'passthrough'
            ? 'The returned content is the full response body, returned verbatim.'
            : 'The returned content is the main text extracted from the page.';
        const citeReminder =
          'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).';
        return text(`${note} ${citeReminder}\n\n${content}`.slice(0, FETCH_URL_MAX_OUTPUT_CHARS));
      } catch (error) {
        if (signal.aborted) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        if (error instanceof HttpFetchError) {
          return errorText(`Failed to fetch URL. Status: ${String(error.status)}. ${msg}`);
        }
        return errorText(`Failed to fetch URL due to network error: ${url}. ${msg}`);
      }
    },
  };
}

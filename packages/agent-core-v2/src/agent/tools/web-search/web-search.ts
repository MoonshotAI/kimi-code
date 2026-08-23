import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  siteName?: string;
}

export interface WebSearchProvider {
  search(
    query: string,
    options?: {
      toolCallId?: string;
      signal?: AbortSignal;
    },
  ): Promise<WebSearchResult[]>;
}

export const WebSearchInputSchema = z.object({
  query: z.string().describe('The query text to search for.'),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export interface IWebSearchTool extends AgentTool<WebSearchInput> {
  readonly _serviceBrand: undefined;
}
export const IWebSearchTool = createDecorator<IWebSearchTool>('webSearchTool');

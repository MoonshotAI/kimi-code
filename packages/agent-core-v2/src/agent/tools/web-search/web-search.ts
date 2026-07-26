/**
 * `tools` domain (L7) — `IWebSearchTool` contract (the `WebSearch` tool).
 *
 * Public contract of the `WebSearch` builtin tool: the model-facing
 * `WebSearchInputSchema` / `WebSearchInput`, the host-injected
 * `WebSearchProvider` interface (plus `WebSearchResult`) the tool delegates
 * the actual search to, and the `IWebSearchTool` DI decorator that the
 * implementation (`webSearchTool.ts`) registers against via
 * `registerAgentToolService`. Web search needs an authenticated Moonshot backend, so
 * the provider is wired in from the App-scope `IWebSearchProviderService`
 * (`auth` domain) at activation time. Bound at Agent scope.
 */

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

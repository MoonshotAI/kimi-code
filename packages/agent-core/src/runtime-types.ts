import type { UrlFetcher, WebSearchProvider } from './tools/builtin';

export interface ToolServices {
  readonly urlFetcher?: UrlFetcher | undefined;
  readonly webSearcher?: WebSearchProvider | undefined;
}

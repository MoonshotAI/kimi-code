import type { Kaos } from '@moonshot-ai/kaos';

import type { UrlFetcher, WebSearchProvider } from './tools/builtin';

export interface RuntimeConfig {
  readonly kaos: Kaos;
  readonly urlFetcher?: UrlFetcher | undefined;
  readonly webSearcher?: WebSearchProvider | undefined;
}

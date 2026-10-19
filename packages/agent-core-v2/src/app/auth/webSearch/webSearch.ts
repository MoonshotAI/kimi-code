import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { WebSearchProvider } from '#/agent/tools/web-search/web-search';

export type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';

export interface IWebSearchProviderService {
  readonly _serviceBrand: undefined;

  getWebSearchProvider(): WebSearchProvider | undefined;
  hasWebSearchProvider(): boolean;
}

export const IWebSearchProviderService: ServiceIdentifier<IWebSearchProviderService> =
  createDecorator<IWebSearchProviderService>('webSearchProviderService');

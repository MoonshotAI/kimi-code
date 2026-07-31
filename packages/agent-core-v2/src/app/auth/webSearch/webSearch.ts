/**
 * `auth` domain (cross-cutting) — OAuth-backed web search seam.
 *
 * Owns the seam for the `WebSearch` backend, which needs an authenticated
 * Moonshot search provider. `IWebSearchProviderService` exposes the
 * configured `WebSearchProvider` (or `undefined` when search is not
 * configured). Tests and hosts that need a custom backend bind
 * `IWebSearchProviderService` directly. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { WebSearchProvider } from '#/agent/tools/web-search/web-search';

export type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';

export interface IWebSearchProviderService {
  readonly _serviceBrand: undefined;

  getWebSearchProvider(): WebSearchProvider | undefined;
}

export const IWebSearchProviderService: ServiceIdentifier<IWebSearchProviderService> =
  createDecorator<IWebSearchProviderService>('webSearchProviderService');

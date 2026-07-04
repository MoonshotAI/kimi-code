/**
 * `auth` domain (cross-cutting) — OAuth-backed web search seam.
 *
 * Owns the host-injection seam for the `WebSearch` backend. `WebSearch` needs
 * an authenticated Moonshot search provider, so it lives here beside the OAuth
 * toolkit rather than in the auth-independent `web` domain.
 * `IWebSearchProviderService` yields the configured `WebSearchProvider` (or
 * `undefined` when search is not configured, in which case the `WebSearch` tool
 * is not registered). The host builds a `MoonshotWebSearchProvider` from the
 * OAuth token (resolved through `IOAuthService`) and binds it here. Bound at
 * App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { WebSearchProvider } from './tools/web-search';

export type { WebSearchProvider, WebSearchResult } from './tools/web-search';

export interface WebSearchProviderOptions {
  /** Search backend. When omitted, `WebSearch` is not registered. */
  readonly provider?: WebSearchProvider;
}

export interface IWebSearchProviderService {
  readonly _serviceBrand: undefined;

  getWebSearchProvider(): WebSearchProvider | undefined;
}

export const IWebSearchProviderService: ServiceIdentifier<IWebSearchProviderService> =
  createDecorator<IWebSearchProviderService>('webSearchProviderService');

/**
 * `web` domain (L4) — URL fetching with an optional OAuth-backed backend.
 *
 * Owns the built-in `FetchURL` tool and the `IWebFetchService` seam that yields
 * its `UrlFetcher`. The default `WebFetchService` routes fetches through the
 * Moonshot fetch service when the managed Kimi OAuth provider is configured
 * (falling back to the built-in `LocalFetchURLProvider` on failure or when no
 * OAuth provider is present), so `FetchURL` works both with and without OAuth.
 * The `MoonshotFetchURLProvider` is also exported as a building block for hosts
 * that bind `IWebFetchService` directly. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { UrlFetcher } from './tools/fetch-url-types';

export type { UrlFetcher, UrlFetchKind, UrlFetchResult } from './tools/fetch-url-types';
export { HttpFetchError } from './tools/fetch-url-types';

export interface IWebFetchService {
  readonly _serviceBrand: undefined;

  getUrlFetcher(): UrlFetcher;
}

export const IWebFetchService: ServiceIdentifier<IWebFetchService> =
  createDecorator<IWebFetchService>('webFetchService');

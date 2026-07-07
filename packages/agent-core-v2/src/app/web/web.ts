/**
 * `web` domain (L4) — auth-independent URL fetching.
 *
 * Owns the built-in `FetchURL` tool and the host-injection seam for its fetch
 * backend. `IWebFetchService` yields the `UrlFetcher` the `FetchURL` tool uses;
 * the default implementation falls back to the built-in `LocalFetchURLProvider`,
 * so `FetchURL` works without any OAuth configuration. The `MoonshotFetchURLProvider`
 * is exported as a building block for hosts that want to route fetches through
 * the Moonshot fetch service. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { UrlFetcher } from './tools/fetch-url-types';

export type { UrlFetcher, UrlFetchKind, UrlFetchResult } from './tools/fetch-url-types';
export { HttpFetchError } from './tools/fetch-url-types';

export interface WebFetchServiceOptions {
  /** URL fetch backend. Defaults to the built-in `LocalFetchURLProvider`. */
  readonly urlFetcher?: UrlFetcher;
}

export interface IWebFetchService {
  readonly _serviceBrand: undefined;

  getUrlFetcher(): UrlFetcher;
}

export const IWebFetchService: ServiceIdentifier<IWebFetchService> =
  createDecorator<IWebFetchService>('webFetchService');

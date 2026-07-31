/**
 * `web` domain — URL fetching with an optional OAuth-backed backend.
 *
 * Declares the `IWebFetchService` seam that yields the `UrlFetcher` behind
 * the built-in `FetchURL` tool, so `FetchURL` works both with and without
 * OAuth. Bound at App scope.
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

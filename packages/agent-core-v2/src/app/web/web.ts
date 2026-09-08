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

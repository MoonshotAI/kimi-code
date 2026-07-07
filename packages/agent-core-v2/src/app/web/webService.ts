/**
 * `web` domain (L4) — `IWebFetchService` implementation.
 *
 * Holds the host-injected `UrlFetcher` (defaulting to the built-in
 * `LocalFetchURLProvider`) and hands it to the `FetchURL` tool through
 * `IWebFetchService`. Owns no tool registration of its own — the `FetchURL`
 * tool self-registers via `registerTool(...)` and reads this service from the
 * Agent-scope accessor. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { LocalFetchURLProvider } from './providers/local-fetch-url';
import type { UrlFetcher } from './tools/fetch-url-types';
import { IWebFetchService, type WebFetchServiceOptions } from './web';

export class WebFetchService implements IWebFetchService {
  declare readonly _serviceBrand: undefined;
  private readonly urlFetcher: UrlFetcher;

  constructor(options: WebFetchServiceOptions = {}) {
    this.urlFetcher = options.urlFetcher ?? new LocalFetchURLProvider();
  }

  getUrlFetcher(): UrlFetcher {
    return this.urlFetcher;
  }
}

registerScopedService(
  LifecycleScope.App,
  IWebFetchService,
  WebFetchService,
  InstantiationType.Delayed,
  'web',
);

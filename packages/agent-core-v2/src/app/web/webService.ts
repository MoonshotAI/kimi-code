/**
 * `web` domain (L4) — `IWebFetchService` implementation.
 *
 * Yields the `UrlFetcher` the `FetchURL` tool uses. When the managed Kimi OAuth
 * provider is configured with an `oauth` ref (the state after a successful Kimi
 * login), builds a `MoonshotFetchURLProvider` that routes fetches through the
 * Moonshot fetch service (`${provider.baseUrl}/fetch`) with a local fallback and
 * the host's Kimi identity headers (`IHostRequestHeaders`, mirroring v1's
 * `kimiRequestHeaders`); otherwise falls back to the built-in
 * `LocalFetchURLProvider`, so `FetchURL` keeps working without any OAuth
 * configuration. Reads the managed provider lazily on each `getUrlFetcher()`
 * call so it tracks login state. Bound at App scope.
 */

import {
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
} from '@moonshot-ai/kimi-code-oauth';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IProviderService } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';

import { LocalFetchURLProvider } from './providers/local-fetch-url';
import { MoonshotFetchURLProvider } from './providers/moonshot-fetch-url';
import type { UrlFetcher } from './tools/fetch-url-types';
import { IWebFetchService } from './web';

export class WebFetchService implements IWebFetchService {
  declare readonly _serviceBrand: undefined;
  private readonly localFetcher: UrlFetcher;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
  ) {
    this.localFetcher = new LocalFetchURLProvider();
  }

  getUrlFetcher(): UrlFetcher {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (provider === undefined || !isOAuthCatalogVendor(provider.type) || provider.oauth === undefined) {
      return this.localFetcher;
    }
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      provider.oauth,
    );
    if (tokenProvider === undefined) {
      return this.localFetcher;
    }
    const baseUrl = `${(provider.baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/fetch`;
    return new MoonshotFetchURLProvider({
      baseUrl,
      tokenProvider,
      defaultHeaders: { ...this.hostHeaders.headers },
      customHeaders: provider.customHeaders,
      localFallback: this.localFetcher,
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IWebFetchService,
  WebFetchService,
  InstantiationType.Eager,
  'web',
);

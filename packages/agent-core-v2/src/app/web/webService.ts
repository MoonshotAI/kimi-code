/**
 * `web` domain (L4) — `IWebFetchService` implementation.
 *
 * Yields the `UrlFetcher` the `FetchURL` tool uses, resolving the backend in
 * precedence order (mirroring v1's `createRuntimeConfig` and the
 * `WebSearchProviderService` chain): (1) an explicit
 * `[services.moonshot_fetch]` config section with a `baseUrl` — built with its
 * `apiKey` and/or an `oauth` ref resolved through
 * `IOAuthService.resolveTokenProvider(...)`; (2) the managed Kimi OAuth
 * provider when it carries an `oauth` ref (the state after a successful Kimi
 * login), routing fetches through the Moonshot fetch service
 * (`${provider.baseUrl}/fetch`); and (3) the built-in `LocalFetchURLProvider`,
 * so `FetchURL` keeps working without any configuration. The first two use the
 * host's Kimi identity headers (`IHostRequestHeaders`, mirroring v1's
 * `kimiRequestHeaders`) and fall back to the local fetcher on failure. Reads
 * config and the managed provider lazily on each `getUrlFetcher()` call so it
 * tracks edits and login state. Bound at App scope.
 */

import {
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
} from '@moonshot-ai/kimi-code-oauth';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { SERVICES_SECTION, type ServicesConfig } from '#/app/auth/configSection';
import { IConfigService } from '#/app/config/config';
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
    @IConfigService private readonly config: IConfigService,
  ) {
    this.localFetcher = new LocalFetchURLProvider();
  }

  getUrlFetcher(): UrlFetcher {
    return this.fromServicesConfig() ?? this.fromManagedOAuth() ?? this.localFetcher;
  }

  private fromServicesConfig(): UrlFetcher | undefined {
    const fetchConfig = this.config.get<ServicesConfig>(SERVICES_SECTION)?.moonshotFetch;
    if (fetchConfig?.baseUrl === undefined) {
      return undefined;
    }
    const tokenProvider =
      fetchConfig.oauth === undefined
        ? undefined
        : this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, fetchConfig.oauth);
    return new MoonshotFetchURLProvider({
      baseUrl: fetchConfig.baseUrl,
      tokenProvider,
      apiKey: nonEmptyString(fetchConfig.apiKey),
      defaultHeaders: { ...this.hostHeaders.headers },
      customHeaders: fetchConfig.customHeaders,
      localFallback: this.localFetcher,
    });
  }

  private fromManagedOAuth(): UrlFetcher | undefined {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (provider === undefined || !isOAuthCatalogVendor(provider.type) || provider.oauth === undefined) {
      return undefined;
    }
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      provider.oauth,
    );
    if (tokenProvider === undefined) {
      return undefined;
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

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

registerScopedService(
  LifecycleScope.App,
  IWebFetchService,
  WebFetchService,
  InstantiationType.Eager,
  'web',
);

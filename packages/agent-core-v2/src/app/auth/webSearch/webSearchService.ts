/**
 * `auth` domain (cross-cutting) — `IWebSearchProviderService` implementation.
 *
 * Resolves the `WebSearch` backend from two sources, in precedence order:
 * (1) an explicit `[services.moonshot_search]` config section (read through
 * `config`, mirroring v1 where that section is the single authoritative
 * web-search source) — built with its `apiKey` and/or an `oauth` ref resolved
 * through `IOAuthService.resolveTokenProvider(...)`; and (2) the managed Kimi
 * OAuth provider (`managed:kimi-code`) when it carries an `oauth` ref (the
 * state after a successful Kimi login), whose bearer token comes from
 * `IOAuthService.resolveTokenProvider(...)` and whose base URL is derived from
 * the provider's `baseUrl`. The explicit config wins over the managed
 * derivation. Both use the host's Kimi identity headers (`IHostRequestHeaders`,
 * mirroring v1's `kimiRequestHeaders`) as default headers. When neither source
 * is configured it yields `undefined` so the self-registering `WebSearch` tool
 * stays hidden. Owns no tool registration — the `WebSearch` tool self-registers
 * via `registerTool(...)` and reads this service from the Agent-scope accessor.
 * Tests and hosts that need a custom backend bind `IWebSearchProviderService`
 * directly. Bound at App scope.
 */

import {
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
} from '@moonshot-ai/kimi-code-oauth';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IProviderService } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';

import { SERVICES_SECTION, type ServicesConfig } from '../configSection';
import { MoonshotWebSearchProvider } from './providers/moonshot-web-search';
import type { WebSearchProvider } from './tools/web-search';
import { IWebSearchProviderService } from './webSearch';

export class WebSearchProviderService implements IWebSearchProviderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
    @IConfigService private readonly config: IConfigService,
  ) {}

  getWebSearchProvider(): WebSearchProvider | undefined {
    return this.fromServicesConfig() ?? this.fromManagedOAuth();
  }

  private fromServicesConfig(): WebSearchProvider | undefined {
    const search = this.config.get<ServicesConfig>(SERVICES_SECTION)?.moonshotSearch;
    if (search?.baseUrl === undefined) {
      return undefined;
    }
    const tokenProvider =
      search.oauth === undefined
        ? undefined
        : this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, search.oauth);
    return new MoonshotWebSearchProvider({
      baseUrl: search.baseUrl,
      tokenProvider,
      apiKey: nonEmptyString(search.apiKey),
      defaultHeaders: { ...this.hostHeaders.headers },
      customHeaders: search.customHeaders,
    });
  }

  private fromManagedOAuth(): WebSearchProvider | undefined {
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
    const baseUrl = `${(provider.baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/search`;
    return new MoonshotWebSearchProvider({
      baseUrl,
      tokenProvider,
      defaultHeaders: { ...this.hostHeaders.headers },
      customHeaders: provider.customHeaders,
    });
  }
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

registerScopedService(
  LifecycleScope.App,
  IWebSearchProviderService,
  WebSearchProviderService,
  InstantiationType.Eager,
  'auth',
);

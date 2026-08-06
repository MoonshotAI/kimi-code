/**
 * `auth` domain (cross-cutting) — `IWebSearchProviderService` implementation.
 *
 * Resolves the `WebSearch` backend from two sources, in precedence order:
 * (1) an explicit `[services.moonshot_search]` config section (read through
 * `config`) — built with its `apiKey` and/or an `oauth` ref resolved
 * through `IOAuthService.resolveTokenProvider(...)`; and (2) the managed Kimi
 * OAuth provider (`managed:kimi-code`) when it carries an `oauth` ref (the
 * state after a successful Kimi login), whose bearer token comes from
 * `IOAuthService.resolveTokenProvider(...)` and whose base URL is derived from
 * the provider's `baseUrl`. The explicit config wins over the managed
 * derivation. When neither source is configured it yields `undefined`.
 * Tests and hosts that need a custom backend bind `IWebSearchProviderService`
 * directly. Bound at App scope.
 *
 * Default headers split by who chose the endpoint: a `[services]` entry names
 * its own, so that path sends `agentIdentity`'s frozen `requestHeaders` — the
 * host header set with the `User-Agent` product token rewritten to the
 * configured identity — while the managed OAuth path sends the host's own
 * headers (`IBootstrapService.args.requestHeaders`) verbatim, being the
 * endpoint the session authenticated against.
 */

import {
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
  type BearerTokenProvider,
} from '@moonshot-ai/kimi-code-oauth';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';

import { SERVICES_SECTION, type ServicesConfig } from '../configSection';
import { MoonshotWebSearchProvider } from './providers/moonshot-web-search';
import type { WebSearchProvider } from '#/agent/tools/web-search/web-search';
import { IWebSearchProviderService } from './webSearch';

export class WebSearchProviderService implements IWebSearchProviderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {}

  getWebSearchProvider(): WebSearchProvider | undefined {
    return this.fromServicesConfig() ?? this.fromManagedOAuth();
  }

  hasWebSearchProvider(): boolean {
    return this.configuredSearch() !== undefined || this.managedTokenProvider() !== undefined;
  }

  private configuredSearch(): (ServicesConfig['moonshotSearch'] & { baseUrl: string }) | undefined {
    const search = this.config.get<ServicesConfig>(SERVICES_SECTION)?.moonshotSearch;
    if (search?.baseUrl === undefined) return undefined;
    return search as ServicesConfig['moonshotSearch'] & { baseUrl: string };
  }

  private managedTokenProvider():
    | { provider: ProviderConfig; tokenProvider: BearerTokenProvider }
    | undefined {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (provider === undefined || !isOAuthCatalogVendor(provider.type) || provider.oauth === undefined) {
      return undefined;
    }
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      provider.oauth,
    );
    if (tokenProvider === undefined) return undefined;
    return { provider, tokenProvider };
  }

  private fromServicesConfig(): WebSearchProvider | undefined {
    const search = this.configuredSearch();
    if (search === undefined) return undefined;
    const tokenProvider =
      search.oauth === undefined
        ? undefined
        : this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, search.oauth);
    return new MoonshotWebSearchProvider({
      baseUrl: search.baseUrl,
      tokenProvider,
      apiKey: nonEmptyString(search.apiKey),
      defaultHeaders: { ...this.identity.current().requestHeaders },
      customHeaders: search.customHeaders,
    });
  }

  private fromManagedOAuth(): WebSearchProvider | undefined {
    const managed = this.managedTokenProvider();
    if (managed === undefined) return undefined;
    const { provider, tokenProvider } = managed;
    const baseUrl = `${(provider.baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/search`;
    return new MoonshotWebSearchProvider({
      baseUrl,
      tokenProvider,
      defaultHeaders: { ...this.bootstrap.args.requestHeaders },
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
  ScopeActivation.OnScopeCreated,
  'auth',
);

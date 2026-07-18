/**
 * `auth` domain (cross-cutting) — `IWebSearchProviderService` implementation.
 *
 * Resolves the `WebSearch` backend from three sources, in precedence order:
 * (1) an explicit `[services.langsearch]` config section (read through `config`)
 * — built with its `apiKey`; takes precedence over Moonshot when configured;
 * (2) an explicit
 * `[services.moonshot_search]` config section (read through `config`, mirroring
 * v1 where that section is the single authoritative web-search source) — built
 * with its `apiKey` and/or an `oauth` ref resolved through
 * `IOAuthService.resolveTokenProvider(...)`; and (3) the managed Kimi OAuth
 * provider (`managed:kimi-code`) when it carries an `oauth` ref (the state
 * after a successful Kimi login), whose bearer token comes from
 * `IOAuthService.resolveTokenProvider(...)` and whose base URL is derived from
 * the provider's `baseUrl`. The explicit configs win over the managed
 * derivation. Both Moonshot sources use the host's Kimi identity headers
 * (`IHostRequestHeaders`, mirroring v1's `kimiRequestHeaders`) as default
 * headers. When a rerank backend is configured via `IRerankService`, the
 * resolved provider is wrapped in a `RerankingWebSearchProvider` so its
 * results are reordered by semantic relevance to the query. When none of the
 * sources is configured it yields `undefined` so the self-registering
 * `WebSearch` tool stays hidden. Owns no tool registration —
 * the `WebSearch` tool self-registers via `registerTool(...)` and reads this
 * service from the Agent-scope accessor. Tests and hosts that need a custom
 * backend bind `IWebSearchProviderService` directly. Bound at App scope.
 */

import {
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
} from '@moonshot-ai/kimi-code-oauth';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IHostRequestHeaders } from '#/app/model/hostRequestHeaders';
import { IProviderService } from '#/app/provider/provider';

import { SERVICES_SECTION, type ServicesConfig } from '../configSection';
import { LANGSEARCH_WEB_SEARCH_FLAG_ID } from './flag';
import { IRerankService } from './rerank';
import { LangSearchWebSearchProvider } from './providers/langsearch-web-search';
import { MoonshotWebSearchProvider } from './providers/moonshot-web-search';
import { RateLimiter, TIER_LIMITS, type LangSearchTier } from './providers/rateLimiter';
import { RerankingWebSearchProvider } from './providers/reranking-web-search';
import type { WebSearchProvider } from './tools/web-search';
import { IWebSearchProviderService } from './webSearch';

export class WebSearchProviderService implements IWebSearchProviderService {
  declare readonly _serviceBrand: undefined;
  private langSearchLimiter: { readonly tier: LangSearchTier; readonly value: RateLimiter } | undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IRerankService private readonly rerankService: IRerankService,
  ) {}

  getWebSearchProvider(): WebSearchProvider | undefined {
    const services = this.config.get<ServicesConfig>(SERVICES_SECTION);
    const limiter = this.resolveLangSearchLimiter(services);
    const search =
      this.fromLangSearchConfig(services, limiter) ??
      this.fromServicesConfig() ??
      this.fromManagedOAuth();
    if (search === undefined) return undefined;
    const reranker = this.rerankService.getRerankProvider(limiter);
    return reranker !== undefined ? new RerankingWebSearchProvider(search, reranker) : search;
  }

  private fromLangSearchConfig(
    services: ServicesConfig | undefined,
    limiter: RateLimiter | undefined,
  ): WebSearchProvider | undefined {
    if (!this.flags.enabled(LANGSEARCH_WEB_SEARCH_FLAG_ID)) return undefined;
    const cfg = services?.langsearch;
    const apiKey = nonEmptyString(cfg?.apiKey);
    if (apiKey === undefined) return undefined;
    return new LangSearchWebSearchProvider({
      apiKey,
      baseUrl: cfg?.baseUrl,
      tier: cfg?.tier,
      freshness: cfg?.freshness,
      summary: cfg?.summary,
      count: cfg?.count,
      customHeaders: cfg?.customHeaders,
      limiter,
    });
  }

  private resolveLangSearchLimiter(services: ServicesConfig | undefined): RateLimiter | undefined {
    if (!this.flags.enabled(LANGSEARCH_WEB_SEARCH_FLAG_ID)) return undefined;
    const searchConfigured = nonEmptyString(services?.langsearch?.apiKey) !== undefined;
    const rerankConfigured =
      services?.rerank?.enabled !== false &&
      services?.rerank?.provider === 'langsearch' &&
      (nonEmptyString(services.rerank.apiKey) ?? nonEmptyString(services.langsearch?.apiKey)) !==
        undefined;
    if (!searchConfigured && !rerankConfigured) return undefined;

    const tier = services?.langsearch?.tier ?? 'free';
    if (this.langSearchLimiter?.tier !== tier) {
      this.langSearchLimiter = {
        tier,
        value: new RateLimiter(TIER_LIMITS[tier], tier),
      };
    }
    return this.langSearchLimiter.value;
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
    if (provider?.type !== 'kimi' || provider.oauth === undefined) {
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

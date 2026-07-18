/**
 * `auth` domain (L2) — `IRerankService` implementation.
 *
 * Resolves the configured rerank backend from the `[services.rerank]` config
 * section (read through `config`). When the section is absent, disabled, or its
 * provider has no usable credential, yields `undefined` so search results are
 * returned in their original order. The `langsearch` provider reuses the `langsearch`
 * search section's `apiKey` when the rerank section does not define its own,
 * and inherits its `tier` for rate limiting. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';

import { SERVICES_SECTION, type ServicesConfig } from '../configSection';
import { LANGSEARCH_WEB_SEARCH_FLAG_ID } from './flag';
import { IRerankService } from './rerank';
import { LangSearchRerankProvider } from './providers/langsearch-rerank';
import type { RateLimiter } from './providers/rateLimiter';

export class RerankService implements IRerankService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
  ) {}

  getRerankProvider(limiter?: RateLimiter) {
    if (!this.flags.enabled(LANGSEARCH_WEB_SEARCH_FLAG_ID)) return undefined;
    const cfg = this.config.get<ServicesConfig>(SERVICES_SECTION);
    if (cfg?.rerank?.enabled === false || cfg?.rerank?.provider !== 'langsearch') {
      return undefined;
    }

    const apiKey = nonEmptyString(cfg.rerank.apiKey) ?? nonEmptyString(cfg.langsearch?.apiKey);
    if (apiKey === undefined) return undefined;
    return new LangSearchRerankProvider({
      apiKey,
      baseUrl: cfg.rerank.baseUrl,
      customHeaders: cfg.rerank.customHeaders,
      tier: cfg.langsearch?.tier,
      limiter,
    });
  }
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

registerScopedService(LifecycleScope.App, IRerankService, RerankService, InstantiationType.Eager, 'auth');

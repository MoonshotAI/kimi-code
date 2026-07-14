/**
 * `auth` domain (cross-cutting) — `IWebSearchProviderService` implementation.
 *
 * Resolves the OAuth-backed `WebSearch` backend for the managed Kimi OAuth
 * provider. When `managed:kimi-code` is configured with an `oauth` ref (the
 * state after a successful Kimi login), this service builds a
 * `MoonshotWebSearchProvider` whose bearer token comes from
 * `IOAuthService.resolveTokenProvider(...)` and whose default headers are the
 * host's Kimi identity headers (`IHostRequestHeaders`, mirroring v1's
 * `kimiRequestHeaders`); otherwise it yields `undefined` so the
 * self-registering `WebSearch` tool stays hidden. Owns no tool registration —
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
import { IHostRequestHeaders } from '#/app/model/hostRequestHeaders';
import { IProviderService } from '#/app/provider/provider';

import { MoonshotWebSearchProvider } from './providers/moonshot-web-search';
import type { WebSearchProvider } from './tools/web-search';
import { IWebSearchProviderService } from './webSearch';

export class WebSearchProviderService implements IWebSearchProviderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
  ) {}

  getWebSearchProvider(): WebSearchProvider | undefined {
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

registerScopedService(
  LifecycleScope.App,
  IWebSearchProviderService,
  WebSearchProviderService,
  InstantiationType.Eager,
  'auth',
);

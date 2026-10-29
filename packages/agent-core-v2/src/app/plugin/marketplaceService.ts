import {
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  kimiCodeBaseUrl,
  kimiRegionProfile,
  resolveKimiCodeRuntimeAuth,
  type BearerTokenProvider,
} from '@moonshot-ai/kimi-code-oauth';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IRegionService } from '#/app/region/region';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes, PluginErrors } from '#/errors';
import { IProviderService } from '#/llm-adapter/provider/provider';

import {
  isMissingMarketplaceTokenError,
  KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV,
  parsePluginMarketplace,
  pluginMarketplaceUrl,
  readPluginMarketplace,
  type PluginMarketplace,
} from './marketplace';
import type { PluginOrigin } from './types';

const MARKETPLACE_FETCH_TIMEOUT_MS = 10_000;

export interface MarketplacePluginInstall {
  readonly source: string;
  readonly version: string;
  readonly sha256sum: string;
  readonly catalogId: string;
  readonly origin: Extract<PluginOrigin, 'marketplace'>;
  readonly expectedPluginId: string;
  readonly fetchImpl: typeof fetch;
}

export interface IPluginMarketplaceService {
  readonly _serviceBrand: undefined;
  listMarketplace(): Promise<PluginMarketplace>;
  resolveInstall(
    marketplaceId: string,
    expectedVersion?: string,
    marketplaceSource?: string,
  ): Promise<MarketplacePluginInstall>;
}

export const IPluginMarketplaceService: ServiceIdentifier<IPluginMarketplaceService> =
  createDecorator<IPluginMarketplaceService>('pluginMarketplaceService');

interface MarketplaceContext {
  readonly source: string;
  readonly managed: boolean;
  readonly tokenProvider?: BearerTokenProvider;
  readonly tokenOrigin?: string;
}

export class PluginMarketplaceService implements IPluginMarketplaceService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IProviderService private readonly providers: IProviderService,
    @IRegionService private readonly regions: IRegionService,
  ) {}

  async listMarketplace(): Promise<PluginMarketplace> {
    return (await this.load()).marketplace;
  }

  async resolveInstall(
    marketplaceId: string,
    expectedVersion?: string,
    marketplaceSource?: string,
  ): Promise<MarketplacePluginInstall> {
    if (marketplaceId === 'kimi-webbridge') {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        'Marketplace plugin "kimi-webbridge" is legacy; install "kimi-browser-extension" instead',
        { details: { marketplaceId, replacementId: 'kimi-browser-extension' } },
      );
    }
    const { marketplace, context } = await this.load(marketplaceSource);
    const entry = marketplace.plugins.find((candidate) => candidate.id === marketplaceId);
    if (entry === undefined) {
      throw new Error2(
        PluginErrors.codes.PLUGIN_NOT_FOUND,
        `Marketplace plugin "${marketplaceId}" was not found in the current catalog`,
        { details: { marketplaceId } },
      );
    }
    const version = entry.version;
    if (version === undefined) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Marketplace plugin "${marketplaceId}" has no version`,
        { details: { marketplaceId } },
      );
    }
    if (expectedVersion !== undefined && version !== expectedVersion) {
      throw new Error2(
        PluginErrors.codes.PLUGIN_CATALOG_CHANGED,
        `Marketplace plugin "${marketplaceId}" changed from version ${expectedVersion} to ${version}; refresh the catalog and retry`,
        {
          details: {
            marketplaceId,
            expectedVersion,
            actualVersion: version,
          },
        },
      );
    }
    if (entry.platforms?.some((platform) => platform === this.bootstrap.platform) !== true) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Marketplace plugin "${marketplaceId}" does not support platform ${this.bootstrap.platform}`,
        { details: { marketplaceId, platform: this.bootstrap.platform } },
      );
    }
    if (entry.sha256sum === undefined) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Marketplace plugin "${marketplaceId}" has no SHA-256 digest`,
        { details: { marketplaceId } },
      );
    }
    return {
      source: entry.source,
      version,
      sha256sum: entry.sha256sum,
      catalogId: entry.id,
      origin: 'marketplace',
      expectedPluginId: entry.id,
      fetchImpl: this.artifactFetch(context),
    };
  }

  private async load(
    marketplaceSource?: string,
  ): Promise<{ marketplace: PluginMarketplace; context: MarketplaceContext }> {
    const context =
      marketplaceSource === undefined
        ? await this.context()
        : { source: marketplaceSource, managed: false };
    const read = await readPluginMarketplace({
      source: context.source,
      workDir: this.bootstrap.cwd,
      fetchImpl: (input, init) => this.catalogFetch(input, init, context),
    });
    return { marketplace: parsePluginMarketplace(read.raw, read.location), context };
  }

  private async context(): Promise<MarketplaceContext> {
    const configuredSource = this.bootstrap.getEnv(KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV);
    if (configuredSource !== undefined) return { source: configuredSource, managed: false };
    await this.providers.ready;
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    const regionBaseUrl = kimiRegionProfile(this.regions.current().region).baseUrl;
    const envBaseUrl = this.bootstrap.getEnv('KIMI_CODE_BASE_URL');
    const envOAuthHost =
      this.bootstrap.getEnv('KIMI_CODE_OAUTH_HOST') ?? this.bootstrap.getEnv('KIMI_OAUTH_HOST');
    const auth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: provider?.baseUrl ?? regionBaseUrl,
      configuredOAuthRef: provider?.oauth,
      env: {
        KIMI_CODE_BASE_URL: envBaseUrl,
        KIMI_CODE_OAUTH_HOST: envOAuthHost,
      },
    });
    const baseUrl = (auth.baseUrl ?? kimiCodeBaseUrl()).trim().replace(/\/+$/, '');
    const tokenProvider = new KimiOAuthToolkit({ homeDir: this.bootstrap.homeDir }).tokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      auth.oauthRef,
    );
    return {
      source: pluginMarketplaceUrl(baseUrl),
      managed: true,
      tokenProvider,
      tokenOrigin: new URL(baseUrl).origin,
    };
  }

  private async catalogFetch(
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
    context: MarketplaceContext,
  ): Promise<Response> {
    const headers = this.requestHeaders(init);
    if (context.managed) {
      let token: string | undefined;
      try {
        token = await context.tokenProvider!.getAccessToken();
      } catch (error) {
        if (!isMissingMarketplaceTokenError(error)) throw error;
      }
      if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
      headers.set('Accept', 'application/json');
    }
    return fetch(input, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
    });
  }

  private artifactFetch(context: MarketplaceContext): typeof fetch {
    return async (input, init) => {
      const headers = this.requestHeaders(init);
      const response = await fetch(input, { ...init, headers });
      if (!context.managed || (response.status !== 401 && response.status !== 403)) {
        return response;
      }
      const responseUrl = response.url || requestUrl(input);
      if (new URL(responseUrl).origin !== context.tokenOrigin) return response;
      await response.body?.cancel().catch(() => undefined);
      const token = await context.tokenProvider!.getAccessToken();
      headers.set('Authorization', `Bearer ${token}`);
      return fetch(responseUrl, { ...init, headers });
    };
  }

  private requestHeaders(init: RequestInit | undefined): Headers {
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(this.bootstrap.args.requestHeaders)) {
      if (!headers.has(key)) headers.set(key, value);
    }
    return headers;
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

registerScopedService(
  LifecycleScope.App,
  IPluginMarketplaceService,
  PluginMarketplaceService,
  ScopeActivation.OnDemand,
  'plugin',
);

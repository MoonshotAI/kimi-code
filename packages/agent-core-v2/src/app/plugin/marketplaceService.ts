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

import { PluginAvailabilityStore, pluginAvailabilitySourceKey } from './availability';
import {
  isMissingMarketplaceTokenError,
  KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV,
  marketplaceEntryInstallableOnHost,
  parsePluginMarketplace,
  pluginClientForIdentity,
  pluginMarketplaceUrl,
  readPluginMarketplace,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
} from './marketplace';
import { resolveInstallSource } from './source';
import type { PluginOrigin } from './types';

const MARKETPLACE_FETCH_TIMEOUT_MS = 10_000;

export interface MarketplacePluginInstall {
  readonly source: string;
  readonly version?: string;
  readonly sha256sum?: string;
  readonly catalogId: string;
  readonly marketplaceSource?: string;
  readonly origin: Extract<PluginOrigin, 'marketplace'>;
  readonly expectedPluginId: string;
  readonly fetchImpl: typeof fetch;
}

export interface IPluginMarketplaceService {
  readonly _serviceBrand: undefined;
  listMarketplace(): Promise<PluginMarketplace>;
  isDefaultMarketplace(): Promise<boolean>;
  resolveInstall(
    marketplaceId: string,
    expectedVersion?: string,
    expectedSha256?: string,
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
  private readonly availability: PluginAvailabilityStore;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IProviderService private readonly providers: IProviderService,
    @IRegionService private readonly regions: IRegionService,
    availability?: PluginAvailabilityStore,
  ) {
    this.availability = availability ?? new PluginAvailabilityStore(bootstrap.homeDir);
  }

  async listMarketplace(): Promise<PluginMarketplace> {
    return (await this.load()).marketplace;
  }

  async isDefaultMarketplace(): Promise<boolean> {
    const configured = this.bootstrap.getEnv(KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV);
    if (configured !== undefined) {
      return this.bootstrap.getEnv('KIMI_CODE_PLUGIN_MARKETPLACE_FROM_DEV_SERVER') === '1';
    }
    return true;
  }

  async resolveInstall(
    marketplaceId: string,
    expectedVersion?: string,
    expectedSha256?: string,
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
    if (expectedVersion !== undefined && entry.version !== expectedVersion) {
      throw catalogChanged(marketplaceId, 'version', expectedVersion, entry.version);
    }
    if (expectedSha256 !== undefined && !/^[A-Fa-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Invalid expected plugin archive SHA-256', {
        details: { marketplaceId, expectedSha256 },
      });
    }
    if (
      expectedSha256 !== undefined &&
      entry.sha256sum?.toLowerCase() !== expectedSha256.toLowerCase()
    ) {
      throw catalogChanged(marketplaceId, 'SHA-256', expectedSha256, entry.sha256sum);
    }
    const sourceKind = resolveInstallSource(entry.source).kind;
    if (sourceKind === 'zip-url' && entry.sha256sum !== undefined && expectedSha256 === undefined) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Marketplace plugin "${marketplaceId}" installation requires the displayed SHA-256 digest`,
        { details: { marketplaceId } },
      );
    }
    const client = pluginClientForIdentity(this.bootstrap.clientIdentity.platform);
    if (!marketplaceEntryInstallableOnHost(entry, client, this.bootstrap.platform)) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Marketplace plugin "${marketplaceId}" does not support ${client} on ${this.bootstrap.platform}`,
        { details: { marketplaceId, client, platform: this.bootstrap.platform } },
      );
    }
    return {
      source: entry.source,
      version: entry.version,
      sha256sum: sourceKind === 'zip-url' ? entry.sha256sum : undefined,
      catalogId: entry.id,
      marketplaceSource: pluginAvailabilitySourceKey(marketplace.source),
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
    const marketplace = parsePluginMarketplace(read.raw, read.location);
    if (context.managed) {
      for (const entry of marketplace.plugins) assertManagedMarketplaceEntry(entry);
    }
    await this.availability.update(marketplace);
    return { marketplace, context };
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
    const headers = this.requestHeaders(init, input, context);
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
    return this.fetchWithRedirects(input, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
    }, context);
  }

  private artifactFetch(context: MarketplaceContext): typeof fetch {
    return async (input, init) => {
      const headers = this.requestHeaders(init, input, context);
      const response = await this.fetchWithRedirects(input, { ...init, headers }, context);
      if (!context.managed || (response.status !== 401 && response.status !== 403)) {
        return response;
      }
      const responseUrl = response.url || requestUrl(input);
      if (new URL(responseUrl).origin !== context.tokenOrigin) return response;
      await response.body?.cancel().catch(() => undefined);
      const token = await context.tokenProvider!.getAccessToken();
      const retryHeaders = this.requestHeaders(init, responseUrl, context);
      retryHeaders.set('Authorization', `Bearer ${token}`);
      return this.fetchWithRedirects(responseUrl, { ...init, headers: retryHeaders }, context);
    };
  }

  private async fetchWithRedirects(
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
    context: MarketplaceContext,
  ): Promise<Response> {
    let currentInput = input;
    let currentInit = init;
    for (let redirect = 0; ; redirect += 1) {
      const response = await fetch(currentInput, { ...currentInit, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      if (redirect >= 10) throw new Error('Too many marketplace redirects');
      await response.body?.cancel().catch(() => undefined);
      currentInput = new URL(location, requestUrl(currentInput));
      currentInit = {
        ...currentInit,
        headers: this.requestHeaders(currentInit, currentInput, context, true),
      };
    }
  }

  private requestHeaders(
    init: RequestInit | undefined,
    input: Parameters<typeof fetch>[0],
    context: MarketplaceContext,
    stripSensitive = false,
  ): Headers {
    const headers = new Headers(init?.headers);
    const crossOrigin = new URL(requestUrl(input)).origin !== context.tokenOrigin;
    if (stripSensitive && crossOrigin) {
      headers.delete('Authorization');
      headers.delete('Proxy-Authorization');
      headers.delete('Cookie');
      for (const key of Object.keys(this.bootstrap.args.requestHeaders)) headers.delete(key);
    }
    if (!context.managed || crossOrigin) return headers;
    for (const [key, value] of Object.entries(this.bootstrap.args.requestHeaders)) {
      if (!headers.has(key)) headers.set(key, value);
    }
    return headers;
  }
}

function assertManagedMarketplaceEntry(entry: PluginMarketplaceEntry): void {
  if (entry.version === undefined) {
    throw new Error2(ErrorCodes.VALIDATION_FAILED, `Marketplace plugin "${entry.id}" has no version`, {
      details: { marketplaceId: entry.id },
    });
  }
  if (entry.distribution === undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Marketplace plugin "${entry.id}" has no distribution`,
      { details: { marketplaceId: entry.id } },
    );
  }
  if (entry.platforms === undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Marketplace plugin "${entry.id}" has no platforms`,
      { details: { marketplaceId: entry.id } },
    );
  }
  if (resolveInstallSource(entry.source).kind !== 'zip-url' || entry.sha256sum === undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Marketplace plugin "${entry.id}" must provide an HTTP(S) ZIP source and SHA-256 digest`,
      { details: { marketplaceId: entry.id } },
    );
  }
}

function catalogChanged(
  marketplaceId: string,
  field: 'version' | 'SHA-256',
  expected: string,
  actual: string | undefined,
): Error2 {
  return new Error2(
    PluginErrors.codes.PLUGIN_CATALOG_CHANGED,
    `Marketplace plugin "${marketplaceId}" changed ${field} from ${expected} to ${actual}; refresh the catalog and retry`,
    { details: { marketplaceId, field, expected, actual } },
  );
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

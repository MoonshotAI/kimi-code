import {
  apiKeyEnvMissingMessage,
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
  type BearerTokenProvider,
} from '@moonshot-ai/kimi-code-oauth';
import { LifecycleScope } from '#/app/scopes';
import { Error2 } from '#/_base/errors/errors';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { CONFIG_INVALID_ERROR_CODE } from '#/llm-adapter/contract/errors';
import { IModelService, type ModelRecord } from '#/llm-adapter/model/model';
import {
  resolveActiveModelProvider,
  resolveModelAuthMaterial,
} from '#/llm-adapter/model/model-auth';
import type { ResolvedModelAuthMaterial } from '#/llm-adapter/model/model.types';
import { IProviderService, type ProviderConfig } from '#/llm-adapter/provider/provider';
import { isOAuthCatalogVendor } from '#/llm-adapter/provider/provider-definition';

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
    @IModelService private readonly models: IModelService,
  ) {}

  getWebSearchProvider(modelAlias?: string): WebSearchProvider | undefined {
    const search = this.configuredSearch();
    if (search !== undefined && search.oauth === undefined) {
      return this.buildServicesSearchProvider(search);
    }
    return (
      this.fromModelProvider(modelAlias) ??
      (search === undefined ? undefined : this.buildServicesSearchProvider(search)) ??
      this.fromManagedOAuth()
    );
  }

  hasWebSearchProvider(modelAlias?: string): boolean {
    const search = this.configuredSearch();
    if (search !== undefined && search.oauth === undefined) return true;
    if (this.modelSearchProvider(modelAlias) !== undefined) return true;
    return search !== undefined || this.managedTokenProvider() !== undefined;
  }

  private configuredSearch(): (ServicesConfig['moonshotSearch'] & { baseUrl: string }) | undefined {
    const search = this.config.get<ServicesConfig>(SERVICES_SECTION)?.moonshotSearch;
    if (search?.baseUrl === undefined) return undefined;
    return search as ServicesConfig['moonshotSearch'] & { baseUrl: string };
  }

  private modelSearchProvider(modelAlias?: string):
    | {
        modelId: string;
        model: ModelRecord;
        providerName: string;
        provider: ProviderConfig;
        searchUrl: string;
      }
    | undefined {
    const resolved = resolveActiveModelProvider(
      modelAlias,
      this.models,
      this.providers,
      this.config,
    );
    const searchUrl = nonEmptyString(resolved?.provider.searchUrl);
    if (resolved === undefined || searchUrl === undefined) return undefined;
    return { ...resolved, searchUrl };
  }

  private fromModelProvider(modelAlias?: string): WebSearchProvider | undefined {
    const resolved = this.modelSearchProvider(modelAlias);
    if (resolved === undefined) return undefined;
    const { modelId, model, providerName, provider, searchUrl } = resolved;
    const auth = resolveModelAuthMaterial({ modelId, model, provider, providerName });
    return new MoonshotWebSearchProvider({
      baseUrl: searchUrl,
      tokenProvider: this.providerTokenProvider(providerName, auth),
      apiKey: auth.apiKey,
      defaultHeaders: { ...this.identity.current().requestHeaders },
      customHeaders: provider.customHeaders,
    });
  }

  private providerTokenProvider(
    providerName: string,
    auth: ResolvedModelAuthMaterial,
  ): BearerTokenProvider | undefined {
    if (auth.apiKeyEnv !== undefined) {
      const envName = auth.apiKeyEnv;
      return {
        getAccessToken: async () => {
          const apiKey = nonEmptyString(process.env[envName]);
          if (apiKey === undefined) {
            throw new Error2(
              CONFIG_INVALID_ERROR_CODE,
              apiKeyEnvMissingMessage(providerName, envName),
            );
          }
          return apiKey;
        },
      };
    }
    if (auth.oauth !== undefined) {
      return this.oauth.resolveTokenProvider(auth.oauthProviderKey ?? providerName, auth.oauth);
    }
    return undefined;
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

  private buildServicesSearchProvider(
    search: ServicesConfig['moonshotSearch'] & { baseUrl: string },
  ): WebSearchProvider {
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

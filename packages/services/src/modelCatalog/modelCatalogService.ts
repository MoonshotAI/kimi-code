import {
  Disposable,
  InstantiationType,
  registerSingleton,
} from '@moonshot-ai/agent-core';
import type { KimiConfig, ProviderConfig } from '@moonshot-ai/agent-core';
import { KimiAuthFacade } from '@moonshot-ai/kimi-code-sdk';
import type {
  ModelCatalogItem,
  ProviderCatalogItem,
  SetDefaultModelResponse,
} from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IEnvironmentService } from '../environment/environment';
import {
  IModelCatalogService,
  ModelNotFoundError,
  ProviderNotFoundError,
  toProtocolModel,
  toProtocolProvider,
} from './modelCatalog';

export class ModelCatalogService
  extends Disposable
  implements IModelCatalogService {
  readonly _serviceBrand: undefined;

  private readonly _authFacade: KimiAuthFacade;

  constructor(
    @IEnvironmentService env: IEnvironmentService,
    @ICoreProcessService private readonly core: ICoreProcessService,
  ) {
    super();
    this._authFacade = new KimiAuthFacade({
      homeDir: env.homeDir,
      configPath: env.configPath,
    });
  }

  async listModels(): Promise<readonly ModelCatalogItem[]> {
    const config = await this._readConfig();
    return Object.entries(config.models ?? {}).map(([modelId, alias]) =>
      toProtocolModel(modelId, alias),
    );
  }

  async listProviders(): Promise<readonly ProviderCatalogItem[]> {
    const config = await this._readConfig();
    const out: ProviderCatalogItem[] = [];
    for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
      out.push(await this._provider(config, providerId, provider));
    }
    return out;
  }

  async getProvider(providerId: string): Promise<ProviderCatalogItem> {
    const config = await this._readConfig();
    const provider = config.providers?.[providerId];
    if (provider === undefined) {
      throw new ProviderNotFoundError(providerId);
    }
    return this._provider(config, providerId, provider);
  }

  async setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    const config = await this._readConfig();
    const alias = config.models?.[modelId];
    if (alias === undefined) {
      throw new ModelNotFoundError(modelId);
    }

    const updated = await this.core.rpc.setKimiConfig({ defaultModel: modelId });
    const updatedAlias = updated.models?.[modelId] ?? alias;
    return {
      default_model: modelId,
      model: toProtocolModel(modelId, updatedAlias),
    };
  }

  private async _readConfig(): Promise<KimiConfig> {
    return this.core.rpc.getKimiConfig({ reload: true });
  }

  private async _provider(
    config: KimiConfig,
    providerId: string,
    provider: ProviderConfig,
  ): Promise<ProviderCatalogItem> {
    const hasApiKey = hasConfiguredApiKey(provider);
    const hasOAuthToken = await this._hasCachedToken(providerId, provider);
    return toProtocolProvider(providerId, provider, config, {
      hasApiKey,
      hasOAuthToken,
    });
  }

  private async _hasCachedToken(
    providerId: string,
    provider: ProviderConfig,
  ): Promise<boolean> {
    if (provider.oauth === undefined) return false;
    try {
      const token = await this._authFacade.getCachedAccessToken(
        providerId,
        provider.oauth,
      );
      return nonEmpty(token) !== undefined;
    } catch {
      return false;
    }
  }
}

function hasConfiguredApiKey(provider: ProviderConfig): boolean {
  if (nonEmpty(provider.apiKey) !== undefined) return true;
  switch (provider.type) {
    case 'anthropic':
      return nonEmpty(provider.env?.['ANTHROPIC_API_KEY']) !== undefined;
    case 'openai':
    case 'openai_responses':
      return nonEmpty(provider.env?.['OPENAI_API_KEY']) !== undefined;
    case 'kimi':
      return nonEmpty(provider.env?.['KIMI_API_KEY']) !== undefined;
    case 'google-genai':
      return nonEmpty(provider.env?.['GOOGLE_API_KEY']) !== undefined;
    case 'vertexai':
      return (
        nonEmpty(provider.env?.['VERTEXAI_API_KEY']) !== undefined ||
        nonEmpty(provider.env?.['GOOGLE_API_KEY']) !== undefined
      );
  }
  return false;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

registerSingleton(IModelCatalogService, ModelCatalogService, InstantiationType.Delayed);

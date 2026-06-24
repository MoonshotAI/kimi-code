/**
 * `kosong` domain (L1) — `IModelCatalogService` / `IProviderManager` /
 * `ILLMService` implementation.
 *
 * `ModelCatalogService` reads provider/model entries from the `kosong` config
 * section. `ProviderManager` resolves a concrete provider+model (explicit ids
 * or config defaults). `LLMService.generate` is the Agent-scope LLM entry
 * point; the full kosong `generate` wiring (auth, streaming, message mapping)
 * is left as a structural TODO — the dependency shape is what matters here.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentConfigService, IConfigService } from '#/config/config';
import { IEnvironmentService } from '#/environment/environment';

import {
  type GenerateArgs,
  type GenerateResult,
  type ModelInfo,
  type ProviderInfo,
  type ResolvedProvider,
  ILLMService,
  IModelCatalogService,
  IProviderManager,
} from './kosong';

interface KosongSection {
  readonly providers?: readonly ProviderInfo[];
  readonly models?: readonly ModelInfo[];
  readonly defaultProviderId?: string;
  readonly defaultModelId?: string;
}

export class ModelCatalogService implements IModelCatalogService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IEnvironmentService _env: IEnvironmentService,
  ) {}

  private section(): KosongSection {
    return this.config.get<KosongSection>('kosong') ?? {};
  }

  listProviders(): Promise<readonly ProviderInfo[]> {
    return Promise.resolve(this.section().providers ?? []);
  }

  listModels(providerId?: string): Promise<readonly ModelInfo[]> {
    const models = this.section().models ?? [];
    return Promise.resolve(
      providerId === undefined ? models : models.filter((m) => m.providerId === providerId),
    );
  }

  refresh(): Promise<void> {
    // Re-reading from config is sufficient for the in-memory catalog.
    return Promise.resolve();
  }
}

export class ProviderManager implements IProviderManager {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IModelCatalogService private readonly catalog: IModelCatalogService,
    @IConfigService private readonly config: IConfigService,
  ) {}

  async resolve(providerId?: string, modelId?: string): Promise<ResolvedProvider> {
    const section = this.config.get<KosongSection>('kosong') ?? {};
    const resolvedProvider = providerId ?? section.defaultProviderId;
    const resolvedModel = modelId ?? section.defaultModelId;
    if (resolvedProvider === undefined || resolvedModel === undefined) {
      throw new Error('ProviderManager.resolve: no provider/model specified and no defaults configured');
    }
    const providers = await this.catalog.listProviders();
    if (!providers.some((p) => p.id === resolvedProvider)) {
      throw new Error(`ProviderManager.resolve: unknown provider '${resolvedProvider}'`);
    }
    return { providerId: resolvedProvider, modelId: resolvedModel };
  }
}

export class LLMService implements ILLMService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderManager private readonly providers: IProviderManager,
    @IAgentConfigService private readonly agentConfig: IAgentConfigService,
  ) {}

  // eslint-disable-next-line require-yield -- TODO stub: yields the kosong stream once wired.
  async *generate(_args: GenerateArgs): AsyncIterable<GenerateResult> {
    // Resolve the target provider/model so callers see misconfiguration early;
    // the actual kosong `generate(...)` call (auth, streaming, message mapping)
    // is wired in a later step.
    const resolved = await this.providers.resolve(
      this.agentConfig.provider,
      this.agentConfig.modelAlias,
    );
    throw new Error(`TODO: LLMService.generate (${resolved.providerId}/${resolved.modelId})`);
  }
}

registerScopedService(LifecycleScope.Core, IModelCatalogService, ModelCatalogService, InstantiationType.Delayed, 'kosong');
registerScopedService(LifecycleScope.Session, IProviderManager, ProviderManager, InstantiationType.Delayed, 'kosong');
registerScopedService(LifecycleScope.Agent, ILLMService, LLMService, InstantiationType.Delayed, 'kosong');

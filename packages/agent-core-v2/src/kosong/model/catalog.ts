/**
 * `kosong/model` domain — the pure-data `Model`, the auth-provider
 * contract, and the `IModelCatalog` interface.
 *
 * A `Model` is exactly the configuration-derived data the rest of v2 needs to
 * talk about one configured model: endpoint, auth closure, wire protocol,
 * wire-facing name, headers, capability matrix, and budget knobs. It is NOT
 * a request executor and carries no `with*` morphs — per-turn intent flows
 * through `ModelRequestParams` on `ModelRequester.request(...)` instead.
 * Construction happens exactly once per config generation, in `ModelCatalog`
 * — the only place that assembles Models.
 *
 * `IModelCatalog` is the single lookup the edge layers consume, in one of
 * two shapes:
 *   - want data    → `get(id)`          → the pure-data Model;
 *   - want requests → `getRequester(id)` → the ModelRequester;
 * `findByName` is the reverse map for many-to-many name/alias routing.
 *
 * Enumeration (`listModels` / `listProviders` / `getProvider`) projects the
 * SAME materialization `get` serves into the wire catalog shapes below, so
 * the management surface can never drift from what the runtime resolves.
 * `setDefaultModel` writes the global default-model pointer (through
 * `IModelService`); it is the catalog's only write, validated against
 * materialization so an unresolvable model can never become the default.
 *
 * The catalog caches assembled Models by id and invalidates on the
 * model/provider config-change events. Tests that mutate config
 * BEHIND the service's back (bypassing those events) must call
 * `ModelCatalog.notifyConfigChanged()` to drop the cache.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { Protocol, ProtocolProviderOptions } from '#/kosong/protocol/protocol';

import type { ProviderConfig } from '../provider/provider';

import type { ModelInspection } from './inspection';
import type { ModelRecord } from './model';
import { effectiveModelConfig } from './modelAuth';
import type { ModelRequester } from './modelRequester';

export interface AuthProvider {
  readonly canRefresh?: boolean;

  getAuth(options?: { readonly force?: boolean }): Promise<ProviderRequestAuth | undefined>;
}

export class StaticAuthProvider implements AuthProvider {
  readonly canRefresh = false;

  constructor(private readonly apiKey: string | undefined) {}
  async getAuth(): Promise<ProviderRequestAuth | undefined> {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) return undefined;
    return { apiKey: this.apiKey };
  }
}

export interface Model {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl?: string;
  readonly headers: Readonly<Record<string, string>>;

  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly alwaysThinking: boolean;
  readonly providerType?: string;
  readonly providerName: string;

  readonly authProvider: AuthProvider;
  readonly providerOptions?: ProtocolProviderOptions;
}

export interface ModelPingResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly text?: string;
  readonly finishReason?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
}

export const modelCatalogItemSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  display_name: z.string().min(1).optional(),
  max_context_size: z.number().int().min(1),
  capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
});
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;

export const providerCatalogStatusSchema = z.enum([
  'connected',
  'error',
  'unconfigured',
]);
export type ProviderCatalogStatus = z.infer<typeof providerCatalogStatusSchema>;

export const providerCatalogItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  base_url: z.string().min(1).optional(),
  default_model: z.string().min(1).optional(),
  has_api_key: z.boolean(),
  status: providerCatalogStatusSchema,
  models: z.array(z.string().min(1)).optional(),
});
export type ProviderCatalogItem = z.infer<typeof providerCatalogItemSchema>;

export const setDefaultModelResponseSchema = z.object({
  default_model: z.string().min(1),
  model: modelCatalogItemSchema,
});
export type SetDefaultModelResponse = z.infer<typeof setDefaultModelResponseSchema>;

export interface ProviderCredentialState {
  readonly hasApiKey: boolean;
  readonly hasOAuthToken: boolean;
}

export function toProtocolModel(
  model: Model,
  record: ModelRecord,
  providerType?: string,
): ModelCatalogItem {
  return {
    provider: model.providerName,
    model: model.id,
    display_name: model.displayName ?? model.name ?? model.id,
    max_context_size: model.maxContextSize,
    capabilities: effectiveModelConfig(record, providerType ?? model.providerType).capabilities,
    support_efforts: model.supportEfforts === undefined ? undefined : [...model.supportEfforts],
    default_effort: model.defaultEffort,
  };
}

export function toProtocolModelFallback(
  modelId: string,
  record: ModelRecord,
  providerType?: string,
): ModelCatalogItem {
  const effective = effectiveModelConfig(record, providerType);
  return {
    provider: effective.provider ?? '',
    model: modelId,
    display_name: effective.displayName ?? effective.model ?? modelId,
    max_context_size: effective.maxContextSize ?? 0,
    capabilities: effective.capabilities,
    support_efforts: effective.supportEfforts,
    default_effort: effective.defaultEffort,
  };
}

export function toProtocolProvider(
  providerId: string,
  provider: ProviderConfig,
  models: Readonly<Record<string, ModelRecord>>,
  globalDefaultModel: string | undefined,
  credential: ProviderCredentialState,
): ProviderCatalogItem {
  const providerModels = modelIdsForProvider(models, providerId);
  const defaultModel =
    provider.defaultModel ?? globalDefaultForProvider(models, globalDefaultModel, providerId);
  return {
    id: providerId,
    type: provider.type ?? 'openai',
    base_url: provider.baseUrl,
    default_model: defaultModel,
    has_api_key: credential.hasApiKey,
    status: credential.hasApiKey || credential.hasOAuthToken ? 'connected' : 'unconfigured',
    models: providerModels,
  };
}

export function modelIdsForProvider(
  models: Readonly<Record<string, ModelRecord>>,
  providerId: string,
): string[] {
  return Object.entries(models)
    .filter(([, record]) => record.provider === providerId)
    .map(([modelId]) => modelId);
}

export function globalDefaultForProvider(
  models: Readonly<Record<string, ModelRecord>>,
  globalDefaultModel: string | undefined,
  providerId: string,
): string | undefined {
  if (globalDefaultModel === undefined) return undefined;
  const record = models[globalDefaultModel];
  return record?.provider === providerId ? globalDefaultModel : undefined;
}

export interface IModelCatalog {
  readonly _serviceBrand: undefined;

  get(id: string): Model;
  getRequester(id: string): ModelRequester;
  inspect(id: string): ModelInspection;
  ping(id: string): Promise<ModelPingResult>;
  findByName(name: string): readonly string[];

  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(providerId: string): Promise<ProviderCatalogItem>;
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse>;
}

export const IModelCatalog: ServiceIdentifier<IModelCatalog> =
  createDecorator<IModelCatalog>('modelResolver');

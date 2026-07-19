/**
 * `kosong/provider` domain (L2) — the provider configuration contract.
 *
 * A Provider is the "endpoint + model-enumeration mechanism" boundary: it
 * carries the concrete `baseUrl`, any custom HTTP headers, and — through
 * `modelSource` — declares how the runtime should discover the Models it
 * serves (static list from `[models.*]`, `/v1/models` discovery, or an
 * OAuth-managed catalog).
 *
 * `ProviderTypeSchema` is deliberately free-form text: vendor identity is NOT
 * enumerated at parse time. Validation happens at resolve time against the
 * provider-definition registry (`getProviderDefinition`), which is what
 * allows external packages to register new vendors without touching this
 * schema.
 *
 * Owns the `ProviderConfig` / `OAuthRef` models and the `providers` config
 * section; App-scoped. Higher-level services (auth, model catalog, CLI, UI)
 * mutate providers through this domain instead of writing config directly.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

/**
 * Free-form vendor identity (e.g. `'kimi'`). Not an enum, by design — see the
 * module header.
 */
export const ProviderTypeSchema = z.string();

export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

export type OAuthRef = z.infer<typeof OAuthRefSchema>;

const StringRecordSchema = z.record(z.string(), z.string());

export const ModelSourceSchema = z.enum(['static', 'discover', 'oauth-catalog']);
export type ModelSource = z.infer<typeof ModelSourceSchema>;

export const ProviderConfigSchema = z.object({
  modelSource: ModelSourceSchema.optional(),

  baseUrl: z.string().optional(),
  customHeaders: StringRecordSchema.optional(),
  defaultModel: z.string().optional(),

  type: ProviderTypeSchema.optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const PROVIDERS_SECTION = 'providers';

export const DEFAULT_PROVIDER_SECTION = 'defaultProvider';

export const ENV_MODEL_PROVIDER_KEY = '__kimi_env__';

export const ProvidersSectionSchema = z.record(z.string(), ProviderConfigSchema);

export type ProvidersSection = z.infer<typeof ProvidersSectionSchema>;

export interface ProvidersChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface IProviderService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChangeProviders: Event<ProvidersChangedEvent>;
  get(name: string): ProviderConfig | undefined;
  list(): Readonly<Record<string, ProviderConfig>>;
  set(name: string, config: ProviderConfig): Promise<void>;
  delete(name: string): Promise<void>;
}

export const IProviderService: ServiceIdentifier<IProviderService> =
  createDecorator<IProviderService>('providerService');

/**
 * `provider` domain (L2) — provider configuration registry and persistence.
 *
 * A Provider is the "endpoint + model-enumeration mechanism" boundary: it
 * carries the concrete `baseUrl`, any custom HTTP headers, and — through
 * `modelSource` — declares how the runtime should discover the Models it
 * serves (static list from `[models.*]`, `/v1/models` discovery, or an
 * OAuth-managed catalog).
 *
 * A Provider references a Platform through `platformId` for shared auth; if
 * `platformId` is absent, the Provider is anonymous and downstream Models
 * must carry inline `apiKey` / `oauth` themselves (the flat case).
 *
 * The legacy fields `type`, `apiKey`, `oauth`, `env` are retained on the
 * schema so existing configs continue to load; Phase 4's config migration
 * lifts them into a synthesized `[platforms.<providerName>]` entry and drops
 * them from Provider on the first write-back.
 *
 * Owns the `ProviderConfig` / `OAuthRef` models and the `providers` config
 * section; App-scoped. Higher-level services (auth, modelResolver, CLI, UI)
 * mutate providers through this domain instead of writing config directly.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export const ProviderTypeSchema = z.enum([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
]);

export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

export type OAuthRef = z.infer<typeof OAuthRefSchema>;

const StringRecordSchema = z.record(z.string(), z.string());

export type JSONValue = string | number | boolean | null | JSONValue[] | JSONObject;
export interface JSONObject {
  [key: string]: JSONValue;
}

const JSONValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JSONValueSchema),
    z.record(z.string(), JSONValueSchema),
  ]),
);
function hasUnsafeCustomBodyKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsafeCustomBodyKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, entryValue]) =>
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor' ||
      hasUnsafeCustomBodyKey(entryValue),
  );
}

const CustomBodySchema: z.ZodType<JSONObject> = z
  .unknown()
  .superRefine((value, ctx) => {
    if (hasUnsafeCustomBodyKey(value)) {
      ctx.addIssue({ code: 'custom', message: 'customBody cannot contain unsafe object keys' });
    }
  })
  .pipe(z.record(z.string(), JSONValueSchema));

export const ModelSourceSchema = z.enum(['static', 'discover', 'oauth-catalog']);
export type ModelSource = z.infer<typeof ModelSourceSchema>;

export const ProviderConfigSchema = z.object({
  platformId: z.string().optional(),
  modelSource: ModelSourceSchema.optional(),

  baseUrl: z.string().optional(),
  customHeaders: StringRecordSchema.optional(),
  customBody: CustomBodySchema.optional(),
  defaultModel: z.string().optional(),

  type: ProviderTypeSchema.optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const PROVIDERS_SECTION = 'providers';

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

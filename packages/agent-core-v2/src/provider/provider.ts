/**
 * `provider` domain (L2) — provider configuration registry and persistence.
 *
 * Owns the `ProviderConfig` / `OAuthRef` models and the `providers` config
 * section; exposes CRUD over provider configurations and persists them through
 * `config`. Core-scoped — provider configuration is global and shared across
 * sessions. Higher-level services (OAuth, CLI, UI, kosong) mutate providers
 * through this domain instead of writing config directly.
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

export const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const PROVIDERS_SECTION = 'providers';

export const ProvidersSectionSchema = z.record(z.string(), ProviderConfigSchema);

export type ProvidersSection = z.infer<typeof ProvidersSectionSchema>;

export interface IProviderService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  get(name: string): ProviderConfig | undefined;
  list(): Readonly<Record<string, ProviderConfig>>;
  set(name: string, config: ProviderConfig): Promise<void>;
  delete(name: string): Promise<void>;
}

export const IProviderService: ServiceIdentifier<IProviderService> =
  createDecorator<IProviderService>('providerService');

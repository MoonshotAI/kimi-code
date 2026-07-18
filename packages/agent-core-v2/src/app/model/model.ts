/**
 * `model` domain (L2) — model configuration registry contract.
 *
 * Owns the `Model` config record (id → resolution recipe) and the `models`
 * config section; exposes CRUD and persists through `config`. App-scoped —
 * model configuration is global and shared across sessions.
 *
 * Two configuration paths are supported:
 *   - **Structured**: `providerId` references an entry in `[providers.*]`,
 *     and that Provider references a `platformId` in `[platforms.*]` for
 *     shared auth. Multiple Models can share a Provider (and thus its base
 *     URL) and share a Platform (and thus its auth).
 *   - **Flat**: `baseUrl` (+ optional inline `apiKey` / `oauth`) is set
 *     directly on the Model — no `providerId` or Platform required. The
 *     resolver synthesizes a Provider from the baseUrl's origin so multiple
 *     Models targeting the same host converge on one Provider record at
 *     runtime, and treats the Platform as unknown (auth comes from the
 *     Model itself).
 *
 * `name` is the wire-facing model identifier sent to the endpoint and is
 * required — the Model's config-section key is a local id and cannot be used
 * as a fallback. `aliases` is a free-form list of routing keys; callers may
 * request "claude-sonnet-4" and the router picks any Model whose name or
 * aliases match (many-to-many).
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { OAuthRefSchema } from '#/app/provider/provider';
import { ProtocolSchema } from '#/app/protocol/protocol';

export const MODELS_SECTION = 'models';

const ModelBaseSchema = z.object({
  providerId: z.string().optional(),

  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),

  protocol: ProtocolSchema.optional(),

  name: z.string().optional(),
  aliases: z.array(z.string()).optional(),

  provider: z.string().optional(),
  model: z.string().optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  betaApi: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
});

export const ModelOverrideSchema = ModelBaseSchema.omit({
  providerId: true,
  baseUrl: true,
  apiKey: true,
  oauth: true,
  protocol: true,
  name: true,
  aliases: true,
  provider: true,
  model: true,
  betaApi: true,
}).partial();

export const ModelSchema = ModelBaseSchema.extend({
  overrides: ModelOverrideSchema.optional(),
}).passthrough();

export type ModelConfig = z.infer<typeof ModelSchema>;

export const ModelAliasSchema = ModelSchema;
export type ModelAlias = ModelConfig;

export const ModelsSectionSchema = z.record(z.string(), ModelSchema);

export type ModelsSection = z.infer<typeof ModelsSectionSchema>;

export interface ModelsChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface IModelService {
  readonly _serviceBrand: undefined;

  readonly onDidChangeModels: Event<ModelsChangedEvent>;
  get(id: string): ModelConfig | undefined;
  list(): Readonly<Record<string, ModelConfig>>;
  set(id: string, model: ModelConfig): Promise<void>;
  delete(id: string): Promise<void>;
}

export const IModelService: ServiceIdentifier<IModelService> =
  createDecorator<IModelService>('modelService');

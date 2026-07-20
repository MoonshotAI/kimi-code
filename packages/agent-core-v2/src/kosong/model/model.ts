/**
 * `kosong/model` domain (L2) — model configuration registry contract.
 *
 * Owns the `ModelRecord` config record (id → resolution recipe) and the
 * `models` config section; exposes CRUD and persists through `config`. App-
 * scoped — model configuration is global and shared across sessions.
 *
 * Two configuration paths are supported:
 *   - **Structured**: `providerId` references an entry in `[providers.*]`.
 *     Multiple Models can share a Provider (and thus its base URL and auth).
 *   - **Flat**: `baseUrl` (+ optional inline `apiKey` / `oauth`) is set
 *     directly on the Model — no `providerId` required. The catalog
 *     synthesizes a Provider from the baseUrl's origin so multiple Models
 *     targeting the same host converge on one Provider record at runtime
 *     (auth comes from the Model itself).
 *
 * `name` is the wire-facing model identifier sent to the endpoint; `model` is
 * the legacy spelling of the same field (at least one is required at resolve
 * time). `aliases` is a free-form list of routing keys; callers may request
 * "claude-sonnet-4" and the router picks any Model whose name or aliases
 * match (many-to-many).
 *
 * `protocol` names one of the four real wire protocols (no vendor entries —
 * a vendor such as `kimi` is expressed as the referenced provider's free-form
 * `type`, never as a protocol).
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { ProtocolSchema } from '#/kosong/protocol/protocol';

import { OAuthRefSchema } from '../provider/provider';

export const MODELS_SECTION = 'models';

/**
 * The global default-model pointer: a single model id from `[models.*]` used
 * whenever a call site does not name a model explicitly. Cross-domain by
 * nature — written by `IModelCatalog.setDefaultModel` and the OAuth login /
 * refresh flows (`app/auth`), read by runtime resolution fallbacks. The sole
 * owner of the key constant lives here; every consumer imports it.
 */
export const DEFAULT_MODEL_SECTION = 'defaultModel';

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

export const ModelRecordSchema = ModelBaseSchema.extend({
  overrides: ModelOverrideSchema.optional(),
}).passthrough();

export type ModelRecord = z.infer<typeof ModelRecordSchema>;

export const ModelsSectionSchema = z.record(z.string(), ModelRecordSchema);

export type ModelsSection = z.infer<typeof ModelsSectionSchema>;

export interface ModelsChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface IModelService {
  readonly _serviceBrand: undefined;

  readonly onDidChangeModels: Event<ModelsChangedEvent>;
  get(id: string): ModelRecord | undefined;
  list(): Readonly<Record<string, ModelRecord>>;
  set(id: string, model: ModelRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

// The decorator name matches the deleted legacy `app/model` contract
// (`createDecorator` caches by name): keeping the legacy name preserves the
// service identity every caller already resolves by.
export const IModelService: ServiceIdentifier<IModelService> =
  createDecorator<IModelService>('modelService');

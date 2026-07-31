/**
 * `kosong/model` domain — model configuration registry contract.
 *
 * Owns the `ModelRecord` config record type (id → resolution recipe) and the
 * in-memory model registry contract. App-scoped — model configuration is
 * global and shared across sessions. Kosong has no persistence — it defines
 * types only. Persisting mutations is the upper layer's job, not this
 * domain's.
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

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { Protocol } from '#/kosong/protocol/protocol';

import type { OAuthRef } from '../provider/provider';

export interface ModelOverride {
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  reasoningKey?: string;
  adaptiveThinking?: boolean;
  supportEfforts?: string[];
  defaultEffort?: string;
  offEffort?: string;
}

export interface ModelRecord {
  providerId?: string;

  baseUrl?: string;
  apiKey?: string;
  oauth?: OAuthRef;

  protocol?: Protocol;

  name?: string;
  aliases?: string[];

  provider?: string;
  model?: string;
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  reasoningKey?: string;
  adaptiveThinking?: boolean;
  betaApi?: boolean;
  supportEfforts?: string[];
  defaultEffort?: string;
  offEffort?: string;

  overrides?: ModelOverride;

  [key: string]: unknown;
}

export type ModelsSection = Record<string, ModelRecord>;

export interface ModelsChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface DefaultModelChangedEvent {
  readonly id: string | undefined;
}

export interface IModelService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChangeModels: Event<ModelsChangedEvent & IWaitUntil>;
  readonly onDidChangeDefaultModel: Event<DefaultModelChangedEvent & IWaitUntil>;
  get(id: string): ModelRecord | undefined;
  list(): Readonly<Record<string, ModelRecord>>;
  getDefaultModel(): string | undefined;
  set(id: string, model: ModelRecord): Promise<void>;
  delete(id: string): Promise<void>;
  loadAll(models: ModelsSection, defaultModel: string | undefined): void;
  replaceAll(models: ModelsSection): Promise<void>;
  setDefaultModel(id: string | undefined): Promise<void>;
}

export const IModelService: ServiceIdentifier<IModelService> =
  createDecorator<IModelService>('modelService');

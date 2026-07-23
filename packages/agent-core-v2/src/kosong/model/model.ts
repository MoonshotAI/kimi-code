/**
 * `kosong/model` domain (L2) — model configuration registry contract.
 *
 * Owns the `ModelRecord` config record type (id → resolution recipe) and the
 * in-memory model registry contract. App-scoped — model configuration is
 * global and shared across sessions. Kosong has no persistence — it defines
 * types only: the `models` / `defaultModel` section constants, the zod
 * schemas (compile-time pinned to these types), and the TOML transforms all
 * live in the persistence wrapper (`app/kosongConfig/configSection`).
 * Persisting mutations is the upper layer's job, not this domain's.
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

/**
 * The per-model `overrides` sub-record: the tunable subset of the base
 * fields, all optional (runtime-fetched catalog metadata may refine the
 * configured record without touching identity/auth fields).
 */
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

/**
 * The persisted section schema is a passthrough object: unknown fields
 * survive parsing (lossless config round-trip), so the type carries the
 * catch-all index signature too. Declared as a single flat interface (not a
 * `Fields & { [key: string]: unknown }` intersection) so the compile-time
 * schema ≡ type pin in `app/kosongConfig/configSection` compares equal
 * to zod's flattened passthrough inference.
 */
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

/**
 * The in-memory model registry. Kosong owns the state and the change events;
 * persistence is the upper layer's concern (a bridge service hydrates the
 * registry via `loadAll` and subscribes to the change events to persist
 * them), so this domain never touches config storage itself.
 *
 * Mutations (`set` / `delete` / `replaceAll` / `setDefaultModel`) wait for
 * hydration (`ready`) so a caller can never race the initial load, and resolve
 * only after every change listener has finished the work it registered through
 * `waitUntil` — the persistence bridge participates this way, so an awaited
 * mutation means the write has also been persisted. Writes that land an equal
 * value are silent — no event fires — which is what makes the persistence
 * bridge's two-way sync terminate.
 */
export interface IModelService {
  readonly _serviceBrand: undefined;

  /** Resolves when the registry has been hydrated (the first `loadAll`). */
  readonly ready: Promise<void>;
  readonly onDidChangeModels: Event<ModelsChangedEvent & IWaitUntil>;
  /** Fires when the default-model pointer changes value (incl. clearing). */
  readonly onDidChangeDefaultModel: Event<DefaultModelChangedEvent & IWaitUntil>;
  get(id: string): ModelRecord | undefined;
  list(): Readonly<Record<string, ModelRecord>>;
  getDefaultModel(): string | undefined;
  set(id: string, model: ModelRecord): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Bulk hydration by the persistence owner: replaces the whole registry and
   * the default-model pointer. The first call resolves `ready`; later calls
   * behave like a deep-equal-aware sync (only real diffs fire events).
   */
  loadAll(models: ModelsSection, defaultModel: string | undefined): void;
  /** Replaces every model record; the default-model pointer is kept. */
  replaceAll(models: ModelsSection): Promise<void>;
  setDefaultModel(id: string | undefined): Promise<void>;
}

// The decorator name matches the deleted legacy `app/model` contract
// (`createDecorator` caches by name): keeping the legacy name preserves the
// service identity every caller already resolves by.
export const IModelService: ServiceIdentifier<IModelService> =
  createDecorator<IModelService>('modelService');

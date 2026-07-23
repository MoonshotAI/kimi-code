/**
 * `kosong/provider` domain (L2) — the provider configuration contract.
 *
 * A Provider is the "endpoint + model-enumeration mechanism" boundary: it
 * carries the concrete `baseUrl`, any custom HTTP headers, and — through
 * `modelSource` — declares how the runtime should discover the Models it
 * serves (static list from `[models.*]`, `/v1/models` discovery, or an
 * OAuth-managed catalog).
 *
 * `ProviderType` is deliberately free-form text: vendor identity is NOT
 * enumerated at the type level. Validation happens at resolve time against
 * the provider-definition registry (`getProviderDefinition`), which is what
 * allows external packages to register new vendors without touching this
 * contract.
 *
 * Owns the `ProviderConfig` / `OAuthRef` types and the in-memory provider
 * registry contract; App-scoped. Kosong has no persistence — it defines
 * types only: the `providers` section constant, its zod schema
 * (compile-time pinned to these types), the env bindings, and the TOML
 * transforms all live in the persistence wrapper
 * (`app/kosongConfig/configSection`). Higher-level services (auth,
 * model catalog, CLI, UI) mutate providers through this domain; persisting
 * those mutations is the upper layer's job.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';

/**
 * Free-form vendor identity (e.g. `'kimi'`). Not an enum, by design — see the
 * module header.
 */
export type ProviderType = string;

export interface OAuthRef {
  storage: 'file' | 'keyring';
  key: string;
  oauthHost?: string;
}

export type ModelSource = 'static' | 'discover' | 'oauth-catalog';

export interface ProviderConfig {
  modelSource?: ModelSource;

  baseUrl?: string;
  customHeaders?: Record<string, string>;
  defaultModel?: string;

  type?: ProviderType;
  apiKey?: string;
  oauth?: OAuthRef;
  env?: Record<string, string>;
  source?: Record<string, unknown>;
}

export type ProvidersSection = Record<string, ProviderConfig>;

export interface ProvidersChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface DefaultProviderChangedEvent {
  readonly id: string | undefined;
}

/**
 * The in-memory provider registry. Kosong owns the state and the change
 * events; persistence is the upper layer's concern (a bridge service hydrates
 * the registry via `loadAll` and subscribes to the change events to persist
 * them), so this domain never touches config storage itself.
 *
 * Mutations (`set` / `delete` / `replaceAll` / `setDefaultProvider`) wait for
 * hydration (`ready`) so a caller can never race the initial load, and resolve
 * only after every change listener has finished the work it registered through
 * `waitUntil` — the persistence bridge participates this way, so an awaited
 * mutation means the write has also been persisted. Writes that land an equal
 * value are silent — no event fires — which is what makes the persistence
 * bridge's two-way sync terminate.
 */
export interface IProviderService {
  readonly _serviceBrand: undefined;

  /** Resolves when the registry has been hydrated (the first `loadAll`). */
  readonly ready: Promise<void>;
  readonly onDidChangeProviders: Event<ProvidersChangedEvent & IWaitUntil>;
  /** Fires when the default-provider pointer changes value (incl. clearing). */
  readonly onDidChangeDefaultProvider: Event<DefaultProviderChangedEvent & IWaitUntil>;
  get(name: string): ProviderConfig | undefined;
  list(): Readonly<Record<string, ProviderConfig>>;
  getDefaultProvider(): string | undefined;
  set(name: string, config: ProviderConfig): Promise<void>;
  delete(name: string): Promise<void>;
  /**
   * Bulk hydration by the persistence owner: replaces the whole registry and
   * the default-provider pointer. The first call resolves `ready`; later
   * calls behave like a deep-equal-aware sync (only real diffs fire events).
   */
  loadAll(providers: ProvidersSection, defaultProvider: string | undefined): void;
  /** Replaces every provider record; the default-provider pointer is kept. */
  replaceAll(providers: ProvidersSection): Promise<void>;
  setDefaultProvider(id: string | undefined): Promise<void>;
}

export const IProviderService: ServiceIdentifier<IProviderService> =
  createDecorator<IProviderService>('providerService');

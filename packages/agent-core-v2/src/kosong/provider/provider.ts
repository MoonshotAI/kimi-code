/**
 * `kosong/provider` domain — the provider configuration contract.
 *
 * A Provider is the "endpoint + model-enumeration mechanism" boundary: it
 * carries the concrete `baseUrl`, any custom HTTP headers, and — through
 * `modelSource` — declares how the runtime should discover the Models it
 * serves (static list from `[models.*]`, `/v1/models` discovery, or an
 * OAuth-managed catalog).
 *
 * `ProviderType` is deliberately free-form text: vendor identity is NOT
 * enumerated at the type level. Validation happens at resolve time against
 * the provider-definition registry, which is what allows external packages
 * to register new vendors without touching this contract.
 *
 * Owns the `ProviderConfig` / `OAuthRef` types and the in-memory provider
 * registry contract; App-scoped. Kosong has no persistence — it defines
 * types only.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';

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

export interface IProviderService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChangeProviders: Event<ProvidersChangedEvent & IWaitUntil>;
  readonly onDidChangeDefaultProvider: Event<DefaultProviderChangedEvent & IWaitUntil>;
  get(name: string): ProviderConfig | undefined;
  list(): Readonly<Record<string, ProviderConfig>>;
  getDefaultProvider(): string | undefined;
  set(name: string, config: ProviderConfig): Promise<void>;
  delete(name: string): Promise<void>;
  loadAll(providers: ProvidersSection, defaultProvider: string | undefined): void;
  replaceAll(providers: ProvidersSection): Promise<void>;
  setDefaultProvider(id: string | undefined): Promise<void>;
}

export const IProviderService: ServiceIdentifier<IProviderService> =
  createDecorator<IProviderService>('providerService');

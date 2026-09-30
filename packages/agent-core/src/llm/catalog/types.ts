import type {
  LlmEndpoint,
  LlmModelSpec,
  LlmRequestModel,
  ModelCapability,
  ThinkingRequestOptions,
} from '#/llm/request';
import type { LlmRequester } from '#/llm/requester';

export interface CatalogModelDefinition
  extends Partial<LlmModelSpec>,
    Omit<LlmRequestModel, 'spec' | 'thinking'> {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly displayName?: string;
  readonly protocol?: string;
  readonly protocolOptions?: Readonly<Record<string, unknown>>;
  readonly endpoint?: LlmEndpoint;
  readonly defaultThinking?: ThinkingRequestOptions;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface CatalogModel
  extends Omit<CatalogModelDefinition, keyof LlmModelSpec>,
    LlmModelSpec {
  readonly capability: ModelCapability;
  readonly pingError?: string;
}

export type CatalogModelSource = 'static' | 'discover' | 'oauth-catalog';

export interface CatalogProviderInfo {
  readonly type?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly modelSource?: CatalogModelSource;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export type ProviderRequesterSource =
  | LlmRequester<'protocol'>
  | Readonly<Record<string, LlmRequester<'protocol'>>>
  | ((protocol?: string, model?: CatalogModel) => LlmRequester<'protocol'> | undefined);

export interface CatalogProviderHandle {
  readonly id: string;
  readonly requester?: ProviderRequesterSource;
  readonly endpoint?: LlmEndpoint;
  readonly listModels?: (signal: AbortSignal) => Promise<readonly CatalogModelDefinition[]>;
}

export interface CatalogProviderSnapshot {
  readonly info?: CatalogProviderInfo;
  readonly discovered: Readonly<Record<string, CatalogModelDefinition>>;
  readonly override: Readonly<Record<string, CatalogModelDefinition>>;
  readonly pingErrors?: Readonly<Record<string, string>>;
}

export interface CatalogSnapshot {
  readonly providers: Readonly<Record<string, CatalogProviderSnapshot>>;
}

export interface ProviderCatalogStore {
  load(): Promise<CatalogSnapshot | undefined> | CatalogSnapshot | undefined;
  save(snapshot: CatalogSnapshot): Promise<void> | void;
}

export interface ProviderCatalogChangedEvent {
  readonly type: 'changed';
  readonly providers: readonly string[];
}

export interface ProviderCatalogRefreshFailedEvent {
  readonly type: 'refresh-failed';
  readonly providerId: string;
  readonly error: unknown;
}

export type UpsertProviderInput =
  | {
      readonly providerId: string;
      readonly handle?: CatalogProviderHandle;
      readonly info?: CatalogProviderInfo;
      readonly models?: readonly CatalogModelDefinition[];
      readonly refresh?: boolean;
    }
  | {
      readonly providerId?: string;
      readonly handle: CatalogProviderHandle;
      readonly info?: CatalogProviderInfo;
      readonly models?: readonly CatalogModelDefinition[];
      readonly refresh?: boolean;
    };

export interface ProviderCatalog {
  snapshot(): CatalogSnapshot;
  providers(): readonly string[];
  providerInfo(providerId: string): CatalogProviderInfo | undefined;
  models(providerId: string): readonly CatalogModel[];
  model(providerId: string, modelId: string): CatalogModel | undefined;
  requester(providerId: string, modelId: string): LlmRequester<'protocol' | 'model'> | undefined;
  upsert(input: UpsertProviderInput): void;
  bind(handle: CatalogProviderHandle): void;
  remove(providerId: string): void;
  refresh(
    target: string | CatalogProviderHandle | readonly (string | CatalogProviderHandle)[],
  ): void;
  ping(providerId: string, modelId: string): void;
  onChanged(listener: (event: ProviderCatalogChangedEvent) => void): () => void;
  onRefreshFailed(listener: (event: ProviderCatalogRefreshFailedEvent) => void): () => void;
  close(): void;
}

export interface CreateProviderCatalogOptions {
  readonly store?: ProviderCatalogStore;
  readonly snapshot?: CatalogSnapshot;
  readonly handles?: readonly CatalogProviderHandle[];
  readonly pingTimeoutMs?: number;
}

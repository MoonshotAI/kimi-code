import type { LlmModel, ModelCapability } from '#/llm/model';
import type { ProtocolName } from '#/llm/protocol/base';
import type { Provider } from '#/llm/provider';
import type { LlmRequester } from '#/llm/requester/requester';

export interface CatalogOAuthRef {
  readonly storage: 'file' | 'keyring';
  readonly key: string;
  readonly oauthHost?: string;
}

export interface CatalogModelOverrides {
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly capability?: ModelCapability;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly adaptiveThinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
}

export interface CatalogModelDefinition extends LlmModel {
  readonly displayName?: string;
  readonly maxOutputSize?: number;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
  readonly protocol?: ProtocolName;
  readonly defaultEffort?: string;
  readonly adaptiveThinking?: boolean;
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly oauth?: CatalogOAuthRef;
  readonly overrides?: CatalogModelOverrides;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface CatalogProviderInfo {
  readonly type?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly defaultModel?: string;
  readonly oauth?: CatalogOAuthRef;
  readonly env?: Readonly<Record<string, string>>;
  readonly modelSource?: 'static' | 'discover' | 'oauth-catalog';
  readonly source?: Readonly<Record<string, unknown>>;
}

export interface CatalogProviderEntry {
  readonly info?: CatalogProviderInfo;
  readonly discovered: Readonly<Record<string, LlmModel>>;
  readonly override: Readonly<Record<string, CatalogModelDefinition>>;
  readonly pingErrors?: Readonly<Record<string, string>>;
}

export interface CatalogModel extends CatalogModelDefinition {
  readonly pingError?: string;
}

export interface CatalogSnapshot {
  readonly providers: Readonly<Record<string, CatalogProviderEntry>>;
}

export interface ProviderCatalogPersist {
  load(): Promise<CatalogSnapshot | undefined>;
  save(snapshot: CatalogSnapshot): Promise<void>;
}

export interface CatalogModelBinding {
  readonly providerId: string;
  readonly model: CatalogModel;
  createRequester(): LlmRequester;
}

export interface ProviderContribution {
  readonly provider: Provider;
  readonly info?: CatalogProviderInfo;
  readonly models?: readonly CatalogModelDefinition[];
}

export type ProviderType = string;

export interface OAuthRef {
  storage: 'file' | 'keyring';
  key: string;
  oauthHost?: string;
}

export type ModelSource = 'static' | 'discover' | 'oauth-catalog';

export interface ProviderConfig {
  displayName?: string;
  modelSource?: ModelSource;

  baseUrl?: string;
  searchUrl?: string;
  feedbackUrl?: string;
  customHeaders?: Record<string, string>;
  defaultModel?: string;

  type?: ProviderType;
  apiKey?: string;
  apiKeyEnv?: string;
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


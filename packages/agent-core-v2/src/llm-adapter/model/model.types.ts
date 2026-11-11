import type { OAuthRef } from '../provider/provider';

export interface ModelOverrides {
  readonly temperature?: number;
  readonly topP?: number;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
}

export interface ResolvedModelAuthMaterial {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly oauth?: OAuthRef;
  readonly oauthProviderKey?: string;
}

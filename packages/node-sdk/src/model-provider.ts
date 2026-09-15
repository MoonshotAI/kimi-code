import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';
import type { ModelCapability } from '@moonshot-ai/agent-core-v2';

import type { ModelAlias, OAuthRef, ProviderType } from '#/config/index';
import type { Logger } from '#/logging/index';

export type { BearerTokenProvider };

export interface ProviderRequestAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ProviderConfig {
  type: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  generationKwargs?: Record<string, unknown>;
}

export type OAuthTokenProviderResolver = (
  providerName: string,
  oauthRef?: OAuthRef,
) => BearerTokenProvider | undefined;

export interface ResolvedRuntimeProvider {
  readonly providerName: string;
  readonly provider: ProviderConfig;
  readonly modelCapabilities: ModelCapability;
  readonly alwaysThinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly maxOutputSize?: number;
  readonly type: ProviderType;
  readonly protocol: ModelAlias['protocol'];
}

type AuthorizedRequest = <T>(
  request: (auth: ProviderRequestAuth) => Promise<T>,
) => Promise<T>;

export interface ModelProvider {
  readonly defaultModel?: string;
  resolveProviderConfig(model: string): ResolvedRuntimeProvider;
  resolveAuth?(model: string, options?: { readonly log?: Logger }): AuthorizedRequest | undefined;
}

import type { ModelCapability } from '#/kosong/contract/capability';

import type { OAuthRef } from '../provider/provider';

export interface ModelOverrides {
  readonly temperature?: number;
  readonly topP?: number;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
}

export interface CompletionBudgetConfig {
  readonly hardCap?: number;
  readonly fallback?: number;
}

export interface CompletionBudgetParams {
  readonly maxCompletionTokens: number;
  readonly usedContextTokens?: number;
  readonly maxContextTokens?: number;
}

export interface ResolvedModelAuthMaterial {
  readonly apiKey?: string;
  readonly oauth?: OAuthRef;
  readonly oauthProviderKey?: string;
}

export interface ThinkingDefaults {
  readonly enabled?: boolean;
  readonly effort?: string;
}

export interface ModelThinkingMetadata {
  readonly capabilities?: ModelCapability | readonly string[];
  readonly adaptiveThinking?: boolean;
  readonly alwaysThinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

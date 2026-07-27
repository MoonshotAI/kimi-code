/**
 * `kosong/model` domain (L2) — shared pure-data types no single contract owns.
 *
 * One home for the small data interfaces that would otherwise each sit in a
 * near-empty file:
 *   - `ModelOverrides` — the resolved `modelOverrides` effective config
 *     section (populated by the `KIMI_MODEL_*` env overlay). Consumers fold it
 *     into `ModelRequestParams`: `temperature`/`topP` into `sampling`,
 *     `thinkingKeep` into the thinking intent, `maxCompletionTokens` into the
 *     completion budget. Each wire dialect encodes (or drops) the resulting
 *     intent in its own hooks.
 *   - `CompletionBudgetConfig` / `CompletionBudgetParams` — the budget knobs
 *     resolved and folded by the pure functions in `completionBudget.ts`.
 *   - `ResolvedModelAuthMaterial` — the credential material `modelAuth.ts`
 *     resolves out of the Model → Provider precedence chain.
 *   - `ThinkingDefaults` / `ModelThinkingMetadata` — the inputs `thinking.ts`
 *     resolves the effective thinking effort/keep from.
 *
 * Types only — the functions and services that produce or consume them stay
 * in their own files.
 */

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

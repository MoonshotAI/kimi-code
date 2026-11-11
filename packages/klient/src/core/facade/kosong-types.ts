/**
 * Public input types for the merged `global.kosong` facade — the shapes
 * callers use to add providers and models. These are facade-level
 * abstractions; the implementation maps them to the underlying
 * `providerService`/`modelService` wire formats.
 */

import type { HistoryMessage } from '@moonshot-ai/core/llm/history';
import type { ToolDescription as Tool } from '@moonshot-ai/core/llm/message';
import type { ResponseFormat } from '@moonshot-ai/core/llm/request';
import type { InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { LlmRunEvent } from '@moonshot-ai/core/llm/response';

// ---------------------------------------------------------------------------
// Provider auth
// ---------------------------------------------------------------------------

/** How the provider authenticates — API key or managed OAuth. */
export type ProviderAuth =
  | { method: 'api-key'; apiKey: string }
  | { method: 'oauth' };

// ---------------------------------------------------------------------------
// Provider / model inputs
// ---------------------------------------------------------------------------

/** Named provider configuration passed to `kosong.addProvider(id, config)`. */
export interface ProviderInput {
  type: string;
  baseUrl?: string;
  auth: ProviderAuth;
  defaultModel?: string;
}

/**
 * Anonymous (single-model) provider input — all connectivity details inline.
 * Passed as a single object to `kosong.addProvider(config)`.
 */
export interface AnonymousProviderInput {
  /** Used as the model identifier in the model registry. */
  id: string;
  /** Wire model name sent to the provider. */
  model: string;
  /** Protocol identifier (`'openai'`, `'anthropic'`, …). */
  protocol: string;
  baseUrl: string;
  auth: ProviderAuth;
  displayName?: string;
  maxContextSize?: number;
  capabilities?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Generate (streaming)
// ---------------------------------------------------------------------------

export interface GenerateInput {
  readonly systemPrompt: string;
  readonly entries: readonly HistoryMessage[];
  readonly tools?: readonly Tool[];
  readonly responseFormat?: ResponseFormat;
}

export type GenerateParams = InitializedLlmRequestPart;

export type GenerateEvent = LlmRunEvent;

import type Anthropic from '@anthropic-ai/sdk';
import type { GoogleGenAI as GenAIClient } from '@google/genai';
import type OpenAI from 'openai';

import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';
import type { ChatProviderError, ModelCapability } from '@moonshot-ai/agent-core-v2';

import type { ModelAlias, OAuthRef, ProviderType } from '#/config/index';
import type { Logger } from '#/logging/index';

export type { BearerTokenProvider };

export interface ProviderRequestAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

export type ProviderConfig =
  | ({ type: 'anthropic' } & AnthropicOptions)
  | ({ type: 'openai' } & OpenAILegacyOptions)
  | ({ type: 'kimi' } & KimiOptions)
  | ({ type: 'google-genai' } & GoogleGenAIOptions)
  | ({ type: 'openai_responses' } & OpenAIResponsesOptions)
  | ({ type: 'vertexai' } & GoogleGenAIOptions);

interface AnthropicOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  defaultMaxTokens?: number | undefined;
  betaFeatures?: string[] | undefined;
  defaultHeaders?: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  stream?: boolean | undefined;
  adaptiveThinking?: boolean | undefined;
  supportEfforts?: readonly string[] | undefined;
  kimiThinking?: boolean | undefined;
  betaApi?: boolean | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => Anthropic;
  convertError?: (error: unknown) => ChatProviderError | undefined;
}

interface OpenAILegacyOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  maxTokens?: number | undefined;
  reasoningKey?: string | undefined;
  offEffort?: string | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
  generationKwargs?: OpenAILegacyGenerationKwargs | undefined;
}

interface KimiOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  generationKwargs?: GenerationKwargs | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
}

interface GoogleGenAIOptions {
  apiKey?: string | undefined;
  model: string;
  baseUrl?: string | undefined;
  vertexai?: boolean | undefined;
  project?: string | undefined;
  location?: string | undefined;
  stream?: boolean | undefined;
  defaultHeaders?: Record<string, string>;
  clientFactory?: (auth: ProviderRequestAuth) => GenAIClient;
}

interface OpenAIResponsesOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  maxOutputTokens?: number | undefined;
  offEffort?: string | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
  generationKwargs?: OpenAIResponsesGenerationKwargs | undefined;
}

type ToolMessageConversion = 'extract_text' | null;

interface GenerationKwargs {
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  prompt_cache_key?: string | undefined;
  extra_body?: ExtraBody;
}

interface ExtraBody {
  thinking?: ThinkingConfig;
  [key: string]: unknown;
}

interface ThinkingConfig {
  type?: 'enabled' | 'disabled';
  effort?: string;
  keep?: unknown;
  [key: string]: unknown;
}

interface OpenAILegacyGenerationKwargs {
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  [key: string]: unknown;
}

interface OpenAIResponsesGenerationKwargs {
  max_output_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  reasoning_effort?: string | undefined;
  [key: string]: unknown;
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

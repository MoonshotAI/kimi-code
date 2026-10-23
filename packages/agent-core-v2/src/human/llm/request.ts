import type { ModelCapability } from '#/llm/capability';
import type { ResolvedEndpoint } from '#/llm/endpoint';
import type { Message, ToolDescription } from '#/llm/message';
import type { LlmPolicy } from '#/llm/policy/policy';
import type { Protocol } from '#/llm/protocol/protocol';
import type { ResponseFormat } from '#/llm/response-format';
import type { ModelThinkingMetadata, ThinkingRequestOptions } from '#/llm/thinking';

export interface LlmModelSpec {
  readonly provider: string;
  readonly name: string;
  readonly capability?: ModelCapability;
  readonly thinking?: ModelThinkingMetadata;
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
}

export interface LlmSampling {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly stop?: readonly string[];
  readonly seed?: number;
  readonly presencePenalty?: number;
  readonly frequencyPenalty?: number;
}

export interface LlmRequestModel {
  readonly spec: LlmModelSpec;
  readonly thinking?: ThinkingRequestOptions;
  readonly maxOutputTokens?: number | 'none';
  readonly responseFormat?: ResponseFormat;
  readonly sampling?: LlmSampling;
  readonly cacheKey?: string;
}

export interface LlmCredential {
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
}

export interface LlmCredentialProvider {
  resolve(): Promise<LlmCredential | undefined> | LlmCredential | undefined;
  canRecover?(error: unknown): boolean;
  invalidate?(): void;
}

export interface LlmEndpoint {
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  readonly credentials?: LlmCredentialProvider;
  readonly defaultBaseUrl?: string;
  readonly clientFactory?: (endpoint: ResolvedEndpoint) => unknown;
  readonly fetch?: typeof fetch;
}

export interface LlmProtocolBinding<TOptions = any> {
  readonly base: Protocol<TOptions>;
  readonly options?: TOptions;
  readonly stream?: boolean;
}

export interface LlmRequestProfile {
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDescription[];
}

export interface LlmRequestContent {
  readonly messages: readonly Message[];
  readonly usedTokens?: number;
}

export interface LlmRequest {
  readonly protocol: LlmProtocolBinding;
  readonly endpoint?: LlmEndpoint;
  readonly model: LlmRequestModel;
  readonly profile?: LlmRequestProfile;
  readonly content: LlmRequestContent;
  readonly policy?: LlmPolicy;
}

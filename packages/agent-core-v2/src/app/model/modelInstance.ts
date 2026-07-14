/**
 * `model` domain (L2) — `Model` god-object contract.
 *
 * A `Model` is the runtime object the rest of v2 requests inference against.
 * It is self-contained: endpoint, resolved auth closure, protocol, wire-facing
 * model name, headers, capability matrix, budget knobs, and the `request()`
 * driver are all held on the instance. Callers supply only what varies per
 * turn — `systemPrompt`, `tools`, `messages`, and an `AbortSignal`.
 *
 * `IModelResolver.resolve(id)` is the sole factory: it reads the Model /
 * Provider / Platform records from `config` and returns a runnable instance.
 * Model is immutable at the field level; `withThinking(...)` and the other
 * `with*` methods return a new Model wrapper without mutating the original.
 *
 * The god-object shape is what enables the Platform × Protocol × Provider
 * decomposition — those three domains are purely construction-time metadata
 * sources; the running system only ever sees Models.
 */

import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { FinishReason } from '#/app/llmProtocol/finishReason';
import type { GenerationKwargs } from '#/app/llmProtocol/kimiOptions';
import type { Message, StreamedMessagePart, VideoURLPart } from '#/app/llmProtocol/message';
import type { ResponseFormat } from '#/app/llmProtocol/provider';
import type { MaxCompletionTokensOptions, ProviderRequestAuth, VideoUploadInput } from '#/app/llmProtocol/request';
import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import type { Tool } from '#/app/llmProtocol/tool';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import type { Protocol, ProtocolProviderOptions } from '#/app/protocol/protocol';

export interface AuthProvider {
  readonly canRefresh?: boolean;

  getAuth(options?: { readonly force?: boolean }): Promise<ProviderRequestAuth | undefined>;
}

export interface LLMRequestInput {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly responseFormat?: ResponseFormat;
}

export type LLMEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | {
      readonly type: 'finish';
      readonly message: Message;
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
      readonly id?: string;
    }
  | {
      readonly type: 'timing';
      readonly firstTokenLatencyMs: number;
      readonly streamDurationMs: number;
      readonly requestBuildMs?: number;
      readonly serverFirstTokenMs?: number;
      readonly serverDecodeMs?: number;
      readonly clientConsumeMs?: number;
    };

export interface Model {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl?: string;
  readonly headers: Readonly<Record<string, string>>;

  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly thinkingEffort: ThinkingEffort | null;
  readonly maxCompletionTokens?: number;
  readonly alwaysThinking: boolean;
  readonly providerName: string;

  readonly authProvider: AuthProvider;

  withThinking(effort: ThinkingEffort): Model;

  withMaxCompletionTokens(n: number, options?: MaxCompletionTokensOptions): Model;

  withGenerationKwargs(kwargs: GenerationKwargs): Model;

  withProviderOptions(options: ProtocolProviderOptions): Model;

  withThinkingKeep(keep: string): Model;

  request(input: LLMRequestInput, signal?: AbortSignal): AsyncIterable<LLMEvent>;

  uploadVideo?(
    input: string | VideoUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VideoURLPart>;
}

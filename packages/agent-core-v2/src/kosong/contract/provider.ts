import type { Message, StreamedMessagePart, VideoURLPart } from './message';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

export type ThinkingEffort = 'off' | 'on' | (string & {});

export type JsonSchemaObject = Record<string, unknown>;

export interface JsonObjectResponseFormat {
  readonly type: 'json_object';
}

export interface JsonSchemaResponseFormat {
  readonly type: 'json_schema';
  readonly jsonSchema: {
    readonly name: string;
    readonly schema: JsonSchemaObject;
    readonly strict?: boolean;
    readonly description?: string;
  };
}

export type ResponseFormat = JsonObjectResponseFormat | JsonSchemaResponseFormat;

export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

export interface StreamedMessage {
  [Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart>;
  readonly id: string | null;
  readonly usage: TokenUsage | null;
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
  readonly traceId?: string | null;
}

export interface ProviderRequestAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface SamplingOptions {
  readonly temperature?: number;
  readonly topP?: number;
}

export interface ThinkingRequestOptions {
  readonly effort: ThinkingEffort;
  readonly keep?: string;
}

export interface ToolCallIdPolicy {
  normalize: (id: string) => string;
  maxLength?: number;
}

export interface StreamDecodeStats {
  readonly serverDecodeMs: number;
  readonly clientConsumeMs: number;
}

export interface VideoUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string | undefined;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  auth?: ProviderRequestAuth;
  responseFormat?: ResponseFormat;
  cacheKey?: string;
  sampling?: SamplingOptions;
  thinking?: ThinkingRequestOptions;
  maxCompletionTokens?: number;
  usedContextTokens?: number;
  maxContextTokens?: number;
  onRequestStart?: () => void;
  onRequestSent?: () => void;
  onStreamEnd?: (stats?: StreamDecodeStats) => void;
  onTraceId?: (traceId: string | null) => void;
}

export interface ChatProvider {
  readonly name: string;
  readonly modelName: string;
  readonly thinkingEffort: ThinkingEffort | null;
  readonly maxCompletionTokens?: number;
  generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage>;
  uploadVideo?(input: string | VideoUploadInput, options?: GenerateOptions): Promise<VideoURLPart>;
}

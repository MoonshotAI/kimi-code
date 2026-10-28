import type { ResolvedEndpoint } from '#/llm/endpoint';
import type { MediaKind, Message, ToolDescription } from '#/llm/message';
import type { LlmPolicy } from '#/llm/policy/policy';
import type { Protocol } from '#/llm/protocol/protocol';

export interface ModelCapability {
  readonly image_in?: boolean;
  readonly video_in?: boolean;
  readonly audio_in?: boolean;
  readonly thinking?: boolean;
  readonly tool_use?: boolean;
  readonly dynamically_loaded_tools?: boolean;
}

const MEDIA_CAPABILITY = {
  image: 'image_in',
  audio: 'audio_in',
  video: 'video_in',
} as const satisfies Record<MediaKind, keyof ModelCapability>;

export function capabilityAccepts(capability: ModelCapability | undefined, kind: MediaKind): boolean {
  return capability?.[MEDIA_CAPABILITY[kind]] === true;
}

export interface ModelThinkingMetadata {
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
  readonly adaptiveThinking?: boolean;
}

export interface LlmModelSpec {
  readonly provider: string;
  readonly name: string;
  readonly capability?: ModelCapability;
  readonly thinking?: ModelThinkingMetadata;
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
}

export type ThinkingEffort = 'off' | 'on' | (string & {});

export interface ThinkingRequestOptions {
  readonly effort: ThinkingEffort;
  readonly keep?: string;
}

export interface JsonObjectResponseFormat {
  readonly type: 'json_object';
}

export interface JsonSchemaResponseFormat {
  readonly type: 'json_schema';
  readonly jsonSchema: {
    readonly name: string;
    readonly schema: Record<string, unknown>;
    readonly strict?: boolean;
    readonly description?: string;
  };
}

export type ResponseFormat = JsonObjectResponseFormat | JsonSchemaResponseFormat;

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

export interface LlmFileInput {
  readonly kind: MediaKind;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
}

export interface UploadedMedia {
  readonly url: string;
  readonly id?: string;
  readonly expiresAt?: number;
}

export interface LlmFiles {
  readonly kinds: ReadonlySet<MediaKind>;
  readonly upload: (
    file: LlmFileInput,
    ctx: { readonly endpoint: ResolvedEndpoint; readonly signal: AbortSignal },
  ) => Promise<UploadedMedia>;
}

export interface LlmEndpoint {
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  readonly credentials?: LlmCredentialProvider;
  readonly defaultBaseUrl?: string;
  readonly clientFactory?: (endpoint: ResolvedEndpoint) => unknown;
  readonly fetch?: typeof fetch;
  readonly files?: LlmFiles;
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

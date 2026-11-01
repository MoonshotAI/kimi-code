import type { ResolvedEndpoint } from '#/llm/endpoint';
import type { StreamedMessagePart } from '#/llm/message';
import type {
  LlmRequestContent,
  LlmRequestModel,
  LlmRequestProfile,
  ModelCapability,
} from '#/llm/request';
import type {
  FinishInfo,
  LlmErrorDiagnostics,
  LlmErrorMessage,
  LlmRemoteErrorMessage,
  TokenUsage,
} from '#/llm/response';

import { runPipeline, type EncodeHooks, type PipelineSpec } from './pipeline';
import type { MediaSupport } from './rules/media';
import type { ToolCallIdPolicy } from './rules/tool-call-ids';

export type ToolMessageConversion = 'extract_text' | 'keep_parts';

export interface LlmModule<TOptions = unknown> {
  readonly model: LlmRequestModel;
  readonly profile: LlmRequestProfile;
  readonly content: LlmRequestContent;
  readonly options: TOptions | undefined;
}

export interface DecodeSink {
  onDelta(part: StreamedMessagePart): void;
  onFinish(finish: FinishInfo): void;
  onMessageId(messageId: string): void;
  onUsage(usage: Partial<TokenUsage>): void;
  onError(message: LlmRemoteErrorMessage): void;
  onToolCallEnd(index?: number | string): void;
}

export interface Decoder<TChunk = unknown> {
  push(chunk: TChunk): void;
  end(): void;
}

export interface ProtocolReply<TBody> {
  readonly body: TBody;
  readonly headers?: Record<string, string>;
}

export interface Protocol<
  TOptions = unknown,
  TRequest = any,
  TResponse = any,
  TChunk = any,
  TClient = any,
> {
  readonly media: MediaSupport;
  readonly toolCallId?: ToolCallIdPolicy;
  readonly capability?: (modelName: string) => ModelCapability | undefined;
  readonly encode: (module: LlmModule<TOptions>, hooks?: EncodeHooks) => TRequest;
  readonly usesEndpointFetch?: boolean;
  readonly client: (endpoint: ResolvedEndpoint, options: TOptions | undefined) => TClient;
  readonly send: (
    client: TClient,
    request: TRequest,
    signal: AbortSignal,
  ) => Promise<ProtocolReply<TResponse>>;
  readonly sendStream: (
    client: TClient,
    request: TRequest,
    signal: AbortSignal,
  ) => Promise<ProtocolReply<AsyncIterable<TChunk>>>;
  readonly decoder: (module: LlmModule<TOptions>, sink: DecodeSink) => Decoder<TChunk>;
  readonly replay: (response: TResponse) => Iterable<TChunk>;
  readonly requestId?: (headers: Readonly<Record<string, string>>) => string | undefined;
  readonly decodeError: (error: unknown) => LlmRemoteErrorMessage;
  readonly diagnoseError?: (input: LlmErrorDiagnosticsInput) => LlmErrorDiagnostics;
}

export interface LlmErrorDiagnosticsInput {
  readonly error: LlmErrorMessage;
  readonly rawError?: unknown;
  readonly headers?: Record<string, string>;
}

export interface ProtocolDefinition<
  TOptions,
  TMessage,
  TTool,
  TParams,
  TRequest,
  TResponse,
  TChunk,
  TClient,
> extends Omit<Protocol<TOptions, TRequest, TResponse, TChunk, TClient>, 'encode'>,
    PipelineSpec<TOptions, TMessage, TTool, TParams, TRequest> {}

export type ProtocolPatch<TDefinition> =
  | Partial<TDefinition>
  | ((base: TDefinition) => Partial<TDefinition>);

export interface DefinedProtocol<
  TOptions,
  TMessage,
  TTool,
  TParams,
  TRequest,
  TResponse,
  TChunk,
  TClient,
> extends ProtocolDefinition<
      TOptions,
      TMessage,
      TTool,
      TParams,
      TRequest,
      TResponse,
      TChunk,
      TClient
    >,
    Protocol<TOptions, TRequest, TResponse, TChunk, TClient> {
  with(
    patch: ProtocolPatch<
      ProtocolDefinition<TOptions, TMessage, TTool, TParams, TRequest, TResponse, TChunk, TClient>
    >,
  ): DefinedProtocol<TOptions, TMessage, TTool, TParams, TRequest, TResponse, TChunk, TClient>;
}

export function defineProtocol<
  TOptions,
  TMessage,
  TTool,
  TParams extends object,
  TRequest,
  TResponse,
  TChunk,
  TClient,
>(
  definition: ProtocolDefinition<
    TOptions,
    TMessage,
    TTool,
    TParams,
    TRequest,
    TResponse,
    TChunk,
    TClient
  >,
): DefinedProtocol<TOptions, TMessage, TTool, TParams, TRequest, TResponse, TChunk, TClient> {
  return {
    ...definition,
    encode: (module, hooks) => runPipeline(definition, module, hooks),
    with: (patch) =>
      defineProtocol({
        ...definition,
        ...(typeof patch === 'function' ? patch(definition) : patch),
      }),
  };
}

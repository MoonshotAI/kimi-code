import type { ResolvedEndpoint } from '#/llm/endpoint';
import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { FinishInfo } from '#/llm/finish-reason';
import type { StreamedMessagePart } from '#/llm/message';
import type { ModelCapability } from '#/llm/capability';
import type {
  LlmRequestContent,
  LlmRequestModel,
  LlmRequestProfile,
} from '#/llm/request';
import type { TokenUsage } from '#/llm/usage';

import { runPipeline, type EncodeHooks, type PipelineSpec } from './pipeline';
import type { MediaSupport } from './rules/media';

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
  readonly capability?: (modelName: string) => ModelCapability | undefined;
  readonly requestId?: (headers: Readonly<Record<string, string>>) => string | undefined;
  readonly encode: (module: LlmModule<TOptions>, hooks?: EncodeHooks) => TRequest;
  readonly decoder: (module: LlmModule<TOptions>, sink: DecodeSink) => Decoder<TChunk>;
  readonly replay: (response: TResponse) => Iterable<TChunk>;
  readonly decodeError: (error: unknown) => LlmRemoteErrorMessage;
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

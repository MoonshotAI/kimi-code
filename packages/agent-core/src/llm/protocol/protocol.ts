import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { Message, ToolDescription } from '#/llm/message';
import type {
  LlmClientContext,
  LlmSampling,
  ToolCallIdPolicy,
} from '#/llm/requester/requester';

import type { TraitContext } from './base';
import type { ProviderConnection } from './connection';
import type { FormatRequestInput, StreamParser } from './format';

export interface ProtocolLowered<TNative> {
  readonly source?: Message;
  readonly message: TNative;
}

export interface ProtocolAssembleParts<TNative> {
  readonly messages: readonly TNative[];
  readonly tools: readonly unknown[];
  readonly kwargs: Readonly<Record<string, unknown>>;
}

export interface EncodedKwargs {
  readonly kwargs: Record<string, unknown>;
  readonly preserveThinking: boolean;
}

export interface RequestTrait<TNative = unknown> {
  readonly toolCallIdPolicy?: ToolCallIdPolicy;
  convertMessage?(
    message: Message,
    converted: TNative,
    ctx: TraitContext,
  ): TNative | null;
  mergeHistory?(
    messages: readonly TNative[],
    ctx: TraitContext,
  ): TNative[] | undefined;
  convertTool?(tool: ToolDescription, ctx: TraitContext): unknown;
  buildParams?(
    params: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;
}

export interface ComposeProtocolPorts<TNative, TAssembled, TRequest, TTrait> {
  extras?: object;
  encodeSampling(sampling: LlmSampling | undefined): Record<string, unknown>;
  encodeKwargs(
    input: FormatRequestInput,
    trait: TTrait | undefined,
    ctx: TraitContext,
  ): EncodedKwargs;
  sealKwargs?(
    kwargs: Record<string, unknown>,
    input: FormatRequestInput,
    trait: TTrait | undefined,
    ctx: TraitContext,
  ): Record<string, unknown>;
  lower(
    input: FormatRequestInput,
    trait: TTrait | undefined,
    ctx: TraitContext,
    extras: { readonly preserveThinking: boolean },
  ): Promise<readonly ProtocolLowered<TNative>[]>;
  defaultMergeHistory?(messages: readonly TNative[]): readonly TNative[];
  defaultTool(tool: ToolDescription): unknown;
  assemble(
    input: FormatRequestInput,
    parts: ProtocolAssembleParts<TNative>,
  ): TAssembled;
  encode(
    assembled: TAssembled,
    applyParams: (params: Record<string, unknown>) => Record<string, unknown>,
  ): TRequest;
}

export interface ProtocolStream<TChunk> {
  readonly stream: AsyncIterable<TChunk>;
  readonly headers?: Record<string, string>;
}

export interface ProtocolHandle<TRequest, TChunk, TClient> {
  readonly connection?: ProviderConnection;
  readonly toolCallIdPolicy?: ToolCallIdPolicy;
  prepare(input: FormatRequestInput, ctx: TraitContext): Promise<TRequest>;
  createClient(ctx: LlmClientContext): TClient;
  requestHeaders?(request: TRequest): Record<string, string> | undefined;
  send(
    client: TClient,
    request: TRequest,
    signal: AbortSignal,
  ): Promise<ProtocolStream<TChunk>>;
  createStreamParser(ctx: TraitContext): StreamParser<TChunk>;
  classifyError(error: unknown): LlmRemoteErrorMessage;
}

export function asLowered<TNative>(
  messages: readonly TNative[],
): ProtocolLowered<TNative>[] {
  return messages.map((message) => ({ message }));
}

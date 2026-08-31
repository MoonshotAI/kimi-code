import type { ModelCapability } from '#/kosong/contract/capability';
import type { ChatProviderError } from '#/kosong/contract/errors';
import type { Message, VideoURLPart } from '#/kosong/contract/message';
import type {
  GenerateOptions,
  ThinkingEffort,
  ToolCallIdPolicy,
  VideoUploadInput,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';

import type { ProtocolAdapterConfig } from './protocol';

export interface TraitContext {
  readonly config: ProtocolAdapterConfig;
  readonly providerId?: string;
}

export interface ProtocolEndpoint {
  readonly apiKeyEnv?: string;
  readonly baseUrlEnv?: string;
  readonly defaultBaseUrl?: string;
}

export interface ProtocolTrait {
  readonly strictThinkingValidation?: boolean;

  provides?(ctx: TraitContext): Record<string, unknown> | undefined;

  endpoint?(ctx: TraitContext): ProtocolEndpoint | undefined;

  defaultHeaders?(ctx: TraitContext): Record<string, string> | undefined;

  convertTool?(tool: Tool, ctx: TraitContext): Record<string, unknown> | undefined;

  convertMessage?(
    message: Message,
    converted: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | null;

  mergeHistory?(
    messages: readonly Record<string, unknown>[],
    ctx: TraitContext,
  ): Record<string, unknown>[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  toolCallIdPolicy?(ctx: TraitContext): ToolCallIdPolicy | undefined;

  convertError?(error: unknown, ctx: TraitContext): ChatProviderError | undefined;

  withThinking?(
    effort: ThinkingEffort,
    options: { readonly keep?: string },
    generationKwargs: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  preserveThinking?(
    generationKwargs: Record<string, unknown>,
    ctx: TraitContext,
  ): boolean | undefined;

  withMaxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  cacheKey?(key: string, ctx: TraitContext): Record<string, unknown> | undefined;

  extractUsage?(
    chunk: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | null | undefined;

  reasoningKey?(ctx: TraitContext): string | undefined;

  capability?(modelName: string, ctx: TraitContext): ModelCapability | undefined;

  uploadVideo?(
    input: string | VideoUploadInput,
    options: GenerateOptions | undefined,
    ctx: TraitContext,
  ): Promise<VideoURLPart>;
}

export interface ResolvedTrait {
  readonly trait: ProtocolTrait;
  readonly context: TraitContext;
}

export function traitDefaultHeaders(
  traits: readonly ResolvedTrait[],
): Record<string, string> | undefined {
  let headers: Record<string, string> | undefined;
  for (const { trait, context } of traits) {
    if (trait.defaultHeaders === undefined) continue;
    const declared = trait.defaultHeaders(context);
    if (declared === undefined) continue;
    headers = { ...headers, ...declared };
  }
  return headers;
}

export function traitConvertError(
  traits: readonly ResolvedTrait[],
): ((error: unknown) => ChatProviderError | undefined) | undefined {
  let bound: ((error: unknown) => ChatProviderError | undefined) | undefined;
  for (const { trait, context } of traits) {
    if (trait.convertError === undefined) continue;
    const declared = trait.convertError.bind(trait);
    bound = (error) => declared(error, context);
  }
  return bound;
}

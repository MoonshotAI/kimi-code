import type { ModelCapability } from '#/llm/capability';
import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { Message, ToolDescription } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { ToolCallIdPolicy, ToolMessageConversion } from '#/llm/requester/requester';
import type { ThinkingRequestOptions } from '#/llm/thinking';

export interface TraitContext {
  readonly model: LlmModel;
}

export interface ProtocolEndpoint {
  readonly apiKeyEnv?: string;
  readonly baseUrlEnv?: string;
  readonly defaultBaseUrl?: string;
}

export interface ProtocolTrait {
  readonly strictThinkingValidation?: boolean;

  endpoint?(): ProtocolEndpoint | undefined;

  defaultHeaders?(ctx: TraitContext): Record<string, string> | undefined;

  convertTool?(tool: ToolDescription, ctx: TraitContext): Record<string, unknown> | undefined;

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

  toolMessageConversion?(ctx: TraitContext): ToolMessageConversion | undefined;

  convertError?(error: unknown, ctx: TraitContext): LlmRemoteErrorMessage | undefined;

  cacheKey?(key: string, ctx: TraitContext): Record<string, unknown> | undefined;

  withThinking?(
    thinking: ThinkingRequestOptions,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  preserveThinking?(
    thinking: ThinkingRequestOptions,
    ctx: TraitContext,
  ): boolean | undefined;

  withMaxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  extractUsage?(
    chunk: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | null | undefined;

  reasoningKey?(ctx: TraitContext): string | undefined;

  capability?(modelName: string): ModelCapability | undefined;
}

export interface ThinkingApplication {
  readonly kwargs: Record<string, unknown>;
  readonly preserveThinking: boolean;
}

export function resolveModelConnection(
  model: LlmModel,
  trait: ProtocolTrait | undefined,
): LlmModel {
  const declaration = trait?.endpoint?.();
  if (declaration === undefined) {
    return model;
  }
  const read = (envName: string | undefined): string | undefined => {
    if (envName === undefined) {
      return undefined;
    }
    const value = process.env[envName];
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  return {
    ...model,
    baseUrl: model.baseUrl ?? read(declaration.baseUrlEnv) ?? declaration.defaultBaseUrl,
    apiKey: model.apiKey ?? read(declaration.apiKeyEnv),
  };
}

export type ThinkingFallback = (
  thinking: ThinkingRequestOptions,
  ctx: TraitContext,
) => Record<string, unknown> | undefined;

export function applyThinking(
  kwargs: Record<string, unknown>,
  thinking: ThinkingRequestOptions,
  trait: ProtocolTrait | undefined,
  ctx: TraitContext,
  fallback?: ThinkingFallback,
): ThinkingApplication {
  const hooked = trait?.withThinking?.(thinking, ctx) ?? fallback?.(thinking, ctx);
  return {
    kwargs: hooked === undefined ? kwargs : { ...kwargs, ...hooked },
    preserveThinking: trait?.preserveThinking?.(thinking, ctx) ?? false,
  };
}

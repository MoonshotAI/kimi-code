import type { ToolDescription } from '#/llm/message';
import type { TraitContext } from '#/llm/protocol/base';
import type { ThinkingStrategy } from '#/llm/protocol/thinking';
import type { ToolCallIdPolicy, ToolMessageConversion } from '#/llm/requester/requester';

import type { OpenAIResponsesRawChunk, OpenAIResponsesRawUsage, ResponsesInputItem } from './contract';

export interface OpenAIResponsesTrait {
  readonly toolCallIdPolicy?: ToolCallIdPolicy;
  readonly toolMessageConversion?: ToolMessageConversion;
  readonly strictThinkingValidation?: boolean;

  readonly thinking?: ThinkingStrategy;

  cacheKey?(key: string, ctx: TraitContext): Record<string, unknown> | undefined;

  maxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  convertTool?(tool: ToolDescription, ctx: TraitContext): Record<string, unknown> | undefined;

  mergeHistory?(
    messages: readonly ResponsesInputItem[],
    ctx: TraitContext,
  ): ResponsesInputItem[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  extractUsage?(chunk: OpenAIResponsesRawChunk): OpenAIResponsesRawUsage | null | undefined;
}

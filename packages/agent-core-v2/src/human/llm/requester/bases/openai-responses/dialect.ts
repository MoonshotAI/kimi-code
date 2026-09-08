import type { ToolDescription } from '#/llm/message';
import type { DialectContext, ThinkingStrategy } from '#/llm/protocol/dialect';
import type { ToolCallIdPolicy, ToolMessageConversion } from '#/llm/requester/requester';

import type { OpenAIResponsesRawChunk, ResponsesInputItem } from './contract';

export interface OpenAIResponsesDialect {
  readonly toolCallIdPolicy?: ToolCallIdPolicy;
  readonly toolMessageConversion?: ToolMessageConversion;
  readonly strictThinkingValidation?: boolean;

  readonly thinking?: ThinkingStrategy;

  cacheKey?(key: string, ctx: DialectContext): Record<string, unknown> | undefined;

  maxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: DialectContext,
  ): Record<string, unknown> | undefined;

  convertTool?(tool: ToolDescription, ctx: DialectContext): Record<string, unknown> | undefined;

  mergeHistory?(
    messages: readonly ResponsesInputItem[],
    ctx: DialectContext,
  ): ResponsesInputItem[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: DialectContext,
  ): Record<string, unknown> | undefined;

  extractUsage?(chunk: OpenAIResponsesRawChunk): Record<string, unknown> | null | undefined;
}

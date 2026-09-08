import type { Message, ToolDescription } from '#/llm/message';
import type { DialectContext, ThinkingStrategy } from '#/llm/protocol/dialect';
import type { ToolCallIdPolicy, ToolMessageConversion } from '#/llm/requester/requester';

import type { OpenAIWireMessage } from './lower';

export interface OpenAIDialect {
  readonly reasoningKey?: string;
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

  convertMessage?(
    message: Message,
    converted: OpenAIWireMessage,
    ctx: DialectContext,
  ): OpenAIWireMessage | null;

  mergeHistory?(
    messages: readonly OpenAIWireMessage[],
    ctx: DialectContext,
  ): OpenAIWireMessage[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: DialectContext,
  ): Record<string, unknown> | undefined;

  extractUsage?(chunk: Record<string, unknown>): Record<string, unknown> | null | undefined;
}

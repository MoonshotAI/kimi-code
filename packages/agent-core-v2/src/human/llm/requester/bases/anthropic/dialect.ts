import type { Message, ToolDescription } from '#/llm/message';
import type { DialectContext, ThinkingStrategy } from '#/llm/protocol/dialect';
import type { ToolCallIdPolicy } from '#/llm/requester/requester';

import type { AnthropicWireMessage } from './contract';

export interface AnthropicDialect {
  readonly toolCallIdPolicy?: ToolCallIdPolicy;

  readonly thinking?: ThinkingStrategy;

  maxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: DialectContext,
  ): Record<string, unknown> | undefined;

  convertTool?(tool: ToolDescription, ctx: DialectContext): Record<string, unknown> | undefined;

  convertMessage?(
    message: Message,
    converted: AnthropicWireMessage,
    ctx: DialectContext,
  ): AnthropicWireMessage | null;

  mergeHistory?(
    messages: readonly AnthropicWireMessage[],
    ctx: DialectContext,
  ): AnthropicWireMessage[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: DialectContext,
  ): Record<string, unknown> | undefined;
}

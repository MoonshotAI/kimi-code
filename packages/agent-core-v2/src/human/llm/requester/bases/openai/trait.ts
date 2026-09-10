import type { Message, ToolDescription } from '#/llm/message';
import type { TraitContext } from '#/llm/protocol/base';
import type { ThinkingStrategy } from '#/llm/protocol/thinking';
import type { ToolCallIdPolicy, ToolMessageConversion } from '#/llm/requester/requester';

import type { OpenAIRawChunk, OpenAIRawUsage, OpenAIWireMessage } from './contract';

export interface OpenAITrait {
  readonly reasoningKey?: string;
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

  convertMessage?(
    message: Message,
    converted: OpenAIWireMessage,
    ctx: TraitContext,
  ): OpenAIWireMessage | null;

  mergeHistory?(
    messages: readonly OpenAIWireMessage[],
    ctx: TraitContext,
  ): OpenAIWireMessage[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  extractUsage?(chunk: OpenAIRawChunk): OpenAIRawUsage | null | undefined;
}

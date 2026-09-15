import type { Message, ToolDescription } from '#/llm/message';
import type { TraitContext } from '#/llm/protocol/base';
import type { ThinkingStrategy } from '#/llm/protocol/thinking';
import type { ToolCallIdPolicy } from '#/llm/requester/requester';

import type { AnthropicWireMessage } from './contract';

export interface AnthropicTrait {
  readonly toolCallIdPolicy?: ToolCallIdPolicy;

  readonly thinking?: ThinkingStrategy;

  maxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  convertTool?(tool: ToolDescription, ctx: TraitContext): Record<string, unknown> | undefined;

  acceptedImageMimes?(ctx: TraitContext): ReadonlySet<string> | undefined;

  convertMessage?(
    message: Message,
    converted: AnthropicWireMessage,
    ctx: TraitContext,
  ): AnthropicWireMessage | null;

  mergeHistory?(
    messages: readonly AnthropicWireMessage[],
    ctx: TraitContext,
  ): AnthropicWireMessage[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;
}

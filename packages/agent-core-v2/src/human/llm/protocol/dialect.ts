import type { Message, ToolDescription } from '#/llm/message';
import type { ToolCallIdPolicy, ToolMessageConversion } from '#/llm/requester/requester';

import type { ProtocolHookContext } from './context';

export interface ProtocolDialect {
  convertTool?(tool: ToolDescription, ctx: ProtocolHookContext): Record<string, unknown> | undefined;

  convertMessage?(
    message: Message,
    converted: Record<string, unknown>,
    ctx: ProtocolHookContext,
  ): Record<string, unknown> | null;

  mergeHistory?(
    messages: readonly Record<string, unknown>[],
    ctx: ProtocolHookContext,
  ): Record<string, unknown>[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: ProtocolHookContext,
  ): Record<string, unknown> | undefined;

  cacheKey?(key: string, ctx: ProtocolHookContext): Record<string, unknown> | undefined;

  toolCallIdPolicy?(ctx: ProtocolHookContext): ToolCallIdPolicy | undefined;

  toolMessageConversion?(ctx: ProtocolHookContext): ToolMessageConversion | undefined;

  extractUsage?(
    chunk: Record<string, unknown>,
    ctx: ProtocolHookContext,
  ): Record<string, unknown> | null | undefined;

  reasoningKey?(ctx: ProtocolHookContext): string | undefined;
}

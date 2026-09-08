import type { ToolDescription } from '#/llm/message';
import type { DialectContext, ThinkingStrategy } from '#/llm/protocol/dialect';

import type { GoogleContent } from './contract';

export interface GoogleGenAIDialect {
  readonly thinking?: ThinkingStrategy;

  maxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: DialectContext,
  ): Record<string, unknown> | undefined;

  convertTool?(tool: ToolDescription, ctx: DialectContext): Record<string, unknown> | undefined;

  mergeHistory?(
    contents: readonly GoogleContent[],
    ctx: DialectContext,
  ): GoogleContent[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: DialectContext,
  ): Record<string, unknown> | undefined;
}

import type { ToolDescription } from '#/llm/message';
import type { TraitContext, ThinkingStrategy } from '#/llm/protocol/trait';

import type { GoogleContent } from './contract';

export interface GoogleGenAITrait {
  readonly thinking?: ThinkingStrategy;

  maxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  convertTool?(tool: ToolDescription, ctx: TraitContext): Record<string, unknown> | undefined;

  mergeHistory?(
    contents: readonly GoogleContent[],
    ctx: TraitContext,
  ): GoogleContent[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;
}

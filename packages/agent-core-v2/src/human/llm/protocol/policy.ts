import type { ModelCapability } from '#/llm/capability';
import type { ThinkingRequestOptions } from '#/llm/thinking';

import type { ProtocolHookContext } from './context';

export interface ModelPolicy {
  readonly strictThinkingValidation?: boolean;

  withThinking?(
    thinking: ThinkingRequestOptions,
    ctx: ProtocolHookContext,
  ): Record<string, unknown> | undefined;

  preserveThinking?(
    thinking: ThinkingRequestOptions,
    ctx: ProtocolHookContext,
  ): boolean | undefined;

  withMaxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: ProtocolHookContext,
  ): Record<string, unknown> | undefined;

  capability?(modelName: string): ModelCapability | undefined;
}

export interface ThinkingApplication {
  readonly kwargs: Record<string, unknown>;
  readonly preserveThinking: boolean;
}

export type ThinkingFallback = (
  thinking: ThinkingRequestOptions,
  ctx: ProtocolHookContext,
) => Record<string, unknown> | undefined;

export function applyThinking(
  kwargs: Record<string, unknown>,
  thinking: ThinkingRequestOptions,
  policy: ModelPolicy | undefined,
  ctx: ProtocolHookContext,
  fallback?: ThinkingFallback,
): ThinkingApplication {
  const hooked = policy?.withThinking?.(thinking, ctx) ?? fallback?.(thinking, ctx);
  return {
    kwargs: hooked === undefined ? kwargs : { ...kwargs, ...hooked },
    preserveThinking: policy?.preserveThinking?.(thinking, ctx) ?? false,
  };
}

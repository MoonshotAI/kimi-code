import type { ThinkingRequestOptions } from '#/llm/thinking';

import type { TraitContext } from './base';

export interface ThinkingApplication {
  readonly kwargs: Record<string, unknown>;
  readonly preserveThinking?: boolean;
}

export type ThinkingStrategy = (
  thinking: ThinkingRequestOptions,
  ctx: TraitContext,
) => ThinkingApplication | undefined;

export type ThinkingFallback = (
  thinking: ThinkingRequestOptions,
  ctx: TraitContext,
) => Record<string, unknown> | undefined;

export interface ResolvedThinking {
  readonly kwargs: Record<string, unknown>;
  readonly preserveThinking: boolean;
}

export function applyThinking(
  kwargs: Record<string, unknown>,
  thinking: ThinkingRequestOptions,
  strategy: ThinkingStrategy | undefined,
  ctx: TraitContext,
  fallback?: ThinkingFallback,
): ResolvedThinking {
  const applied = strategy?.(thinking, ctx);
  const hookedKwargs = applied === undefined ? fallback?.(thinking, ctx) : applied.kwargs;
  return {
    kwargs: hookedKwargs === undefined ? kwargs : { ...kwargs, ...hookedKwargs },
    preserveThinking: applied?.preserveThinking ?? false,
  };
}

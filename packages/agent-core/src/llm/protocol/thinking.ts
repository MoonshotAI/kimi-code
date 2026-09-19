import type { ThinkingRequestOptions } from '#/llm/thinking';

import type { TraitContext } from './base';

export interface ThinkingContribution {
  readonly kwargs: Record<string, unknown>;
  readonly preserveThinking?: boolean;
}

export type ThinkingStrategy = (
  thinking: ThinkingRequestOptions,
  ctx: TraitContext,
) => ThinkingContribution | undefined;

export type ThinkingFallback = (
  thinking: ThinkingRequestOptions,
  ctx: TraitContext,
) => Record<string, unknown> | undefined;

export interface AppliedThinking {
  readonly kwargs: Record<string, unknown>;
  readonly preserveThinking: boolean;
}

export function applyThinking(
  kwargs: Record<string, unknown>,
  thinking: ThinkingRequestOptions,
  strategy: ThinkingStrategy | undefined,
  ctx: TraitContext,
  fallback?: ThinkingFallback,
): AppliedThinking {
  const contribution = strategy?.(thinking, ctx);
  const hookedKwargs = contribution === undefined ? fallback?.(thinking, ctx) : contribution.kwargs;
  return {
    kwargs: hookedKwargs === undefined ? kwargs : { ...kwargs, ...hookedKwargs },
    preserveThinking: contribution?.preserveThinking ?? false,
  };
}

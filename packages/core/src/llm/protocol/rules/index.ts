import type { Message } from '#/llm/message';

import { applyPatterns, type Pattern } from '../pattern';
import type { PassContext, PassRunner } from '../pipeline';
import type { LlmModule } from '../protocol';
import { legalizeMedia, relocateToolMedia, type MediaSupport } from './media';
import { legalizeModel, type ModelLegality } from './model';
import { legalizeToolCallIds, type ToolCallIdPolicy } from './tool-call-ids';

export type PatternSet<TOptions> = (
  module: LlmModule<TOptions>,
  ctx: PassContext,
) => readonly Pattern<Message>[];

export interface LegalizeSpec<TOptions> {
  readonly media: MediaSupport;
  readonly toolCallId?: ToolCallIdPolicy;
  readonly patterns?: PatternSet<TOptions>;
  readonly thinkingHistory?: PatternSet<TOptions>;
  readonly legality: ModelLegality;
}

export function legalize<TOptions>(
  input: LlmModule<TOptions>,
  spec: LegalizeSpec<TOptions>,
  keepCacheKey: boolean,
  pass: PassRunner<TOptions>,
): LlmModule<TOptions> {
  const mediaLegal = pass.messages('legalize-media', input, (messages) =>
    legalizeMedia(messages, spec.media),
  );
  const relocated = pass.messages('relocate-tool-media', mediaLegal, (messages) =>
    relocateToolMedia(messages, spec.media),
  );
  const idsLegal = pass.messages('legalize-tool-call-ids', relocated, (messages) =>
    legalizeToolCallIds(messages, spec.toolCallId),
  );
  const patternsLegal = pass.messages('legalize-patterns', idsLegal, (messages, ctx) => {
    const patterns = spec.patterns?.(idsLegal, ctx) ?? [];
    return patterns.length === 0 ? messages : applyPatterns(messages, patterns);
  });
  const thinkingLegal = pass.messages('legalize-thinking-history', patternsLegal, (messages, ctx) => {
    const patterns = spec.thinkingHistory?.(patternsLegal, ctx) ?? [];
    return patterns.length === 0 ? messages : applyPatterns(messages, patterns);
  });
  return pass.model('legalize-model', thinkingLegal, (module, ctx) =>
    legalizeModel(module, spec.legality, keepCacheKey, ctx),
  );
}

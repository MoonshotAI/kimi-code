import type { Message } from '#/llm/message';

import { applyPatterns, type Pattern } from '../pattern';
import type { PassContext, PassRunner } from '../pipeline';
import type { LlmModule } from '../protocol';
import { legalizeMedia, relocateToolMedia, verifyMediaResolved, type MediaSupport } from './media';
import { legalizeModel, type ModelLegality } from './model';
import {
  legalizeStructure,
  legalizeToolCallIds,
  verifyToolExchanges,
  type ToolCallIdPolicy,
} from './structure';

export type PatternSet<TOptions> = (
  module: LlmModule<TOptions>,
  ctx: PassContext,
) => readonly Pattern<Message>[];

export interface LegalizeSpec<TOptions> {
  readonly media: MediaSupport;
  readonly toolCallId?: ToolCallIdPolicy;
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
    legalizeMedia(messages, input.model.spec.capability, spec.media),
  );
  const verified = pass.messages('verify-history', mediaLegal, (messages) =>
    verifyToolExchanges(verifyMediaResolved(messages)),
  );
  const structured = pass.messages('legalize-structure', verified, (messages, ctx) =>
    legalizeStructure(messages, ctx.report),
  );
  const relocated = pass.messages('relocate-tool-media', structured, (messages) =>
    relocateToolMedia(messages, spec.media),
  );
  const idsLegal = pass.messages('legalize-tool-call-ids', relocated, (messages) =>
    legalizeToolCallIds(messages, spec.toolCallId),
  );
  const thinkingLegal = pass.messages('legalize-thinking-history', idsLegal, (messages, ctx) => {
    const patterns = spec.thinkingHistory?.(idsLegal, ctx) ?? [];
    return patterns.length === 0 ? messages : applyPatterns(messages, patterns);
  });
  return pass.model('legalize-model', thinkingLegal, (module, ctx) =>
    legalizeModel(module, spec.legality, keepCacheKey, ctx),
  );
}

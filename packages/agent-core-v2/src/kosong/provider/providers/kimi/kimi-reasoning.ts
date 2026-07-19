/**
 * `kosong/provider` domain (L2) — Kimi reasoning-field trait.
 *
 * `kimiReasoningTrait` declares the wire field carrying reasoning content
 * (`reasoning_content`, used for both inbound extraction and outbound replay)
 * and when to force-replay it: in a `keep: 'all'` session (with thinking not
 * disabled) every assistant message replays its reasoning field. The
 * preserveThinking hook reads the already-seeded request kwargs — the
 * thinking config its sibling params trait just encoded — so it decides per
 * request, not per instance.
 */

import type { ProtocolTrait } from '#/kosong/protocol/protocolTrait';

import type { ExtraBody } from './kimi-params';

export const KIMI_REASONING_KEY = 'reasoning_content';

export const kimiReasoningTrait: ProtocolTrait = {
  reasoningKey: () => KIMI_REASONING_KEY,
  preserveThinking: (generationKwargs) => {
    const extraBody = generationKwargs['extra_body'] as ExtraBody | undefined;
    const thinking = extraBody?.thinking;
    if (thinking?.keep === 'all' && thinking.type !== 'disabled') {
      return true;
    }
    return undefined;
  },
};

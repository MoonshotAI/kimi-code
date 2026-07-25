/**
 * `contextMemory` vacuous-content predicate — shared test for content parts
 * that carry nothing the provider wire can represent, used by the loop-event
 * fold (settle-time drop of output-free steps) and the context projector
 * (wire-time drop of wholly-vacuous messages). Vacuous means an empty or
 * whitespace-only text block, or an empty thinking block with no provider
 * signature; a signed thinking block (`encrypted`) is never vacuous —
 * reasoning providers require it back verbatim — and media parts always
 * carry content.
 */

import type { ContentPart } from '#/kosong/contract/message';

export function isVacuousContentPart(part: ContentPart): boolean {
  if (part.type === 'text') return part.text.trim().length === 0;
  if (part.type === 'think') return part.encrypted === undefined && part.think.trim().length === 0;
  return false;
}

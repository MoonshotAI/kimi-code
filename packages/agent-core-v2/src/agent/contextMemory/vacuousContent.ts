/**
 * `contextMemory` vacuous-content predicate — shared test for content parts
 * that carry nothing the provider wire can represent. Vacuous means an empty
 * or whitespace-only text block, or an empty thinking block with no provider
 * signature; a signed thinking block (`encrypted`) is never vacuous —
 * reasoning providers require it back verbatim — and media parts always
 * carry content.
 */

import type { ContentPart } from '#/kosong/contract/message';

export function isVacuousContentPart(part: ContentPart): boolean {
  switch (part.type) {
    case 'text':
      return part.text.trim().length === 0;
    case 'think':
      return part.encrypted === undefined && part.think.trim().length === 0;
    case 'image_url':
    case 'audio_url':
    case 'video_url':
      return false;
    default: {
      const exhaustive: never = part;
      void exhaustive;
      return false;
    }
  }
}

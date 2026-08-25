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

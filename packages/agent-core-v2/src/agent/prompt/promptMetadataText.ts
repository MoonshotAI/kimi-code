/**
 * `prompt` domain (L4) — safe, displayable metadata text derived from prompts.
 *
 * Shared by prompt submission and rewind projection so `lastPrompt` uses one
 * normalization, redaction, and length limit, with image captions supplied by
 * the `media` domain.
 */

import type { ContentPart } from '#/kosong/contract/message';
import { extractImageCompressionCaptions } from '#/agent/media/image-compress';

const MAX_TITLE_LENGTH = 200;
const MAX_LAST_PROMPT_LENGTH = 4000;

export function titleFromPromptMetadataText(text: string): string {
  return text.slice(0, MAX_TITLE_LENGTH);
}

export function promptMetadataTextFromContentParts(
  parts: readonly ContentPart[],
): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    const text = promptPartText(part);
    if (text !== undefined) texts.push(text);
  }
  return promptMetadataTextFromText(texts.join('\n'));
}

export function promptMetadataTextFromText(text: string): string | undefined {
  const sanitized = text
    .replaceAll(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      '[redacted]',
    )
    .replaceAll(/\b(authorization)\s*:\s*bearer\s+\S+/gi, '$1: Bearer [redacted]')
    .replaceAll(
      /\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1=[redacted]',
    )
    .replaceAll(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replaceAll(/\b[A-Za-z0-9][A-Za-z0-9+/=_-]{39,}\b/g, '[redacted]')
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

  if (sanitized.length === 0) return undefined;
  return sanitized.slice(0, MAX_LAST_PROMPT_LENGTH);
}

function promptPartText(part: ContentPart): string | undefined {
  switch (part.type) {
    case 'text': {
      const { text } = extractImageCompressionCaptions(part.text);
      return text.trim().length === 0 ? undefined : text;
    }
    case 'image_url':
      return '[image]';
    case 'audio_url':
      return '[audio]';
    case 'video_url':
      return '[video]';
    case 'think':
      return undefined;
  }
}

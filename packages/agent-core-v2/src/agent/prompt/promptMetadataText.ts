import { promptDisplayTextFromContentParts } from '#human/agent/origin';
import type { ContentPart } from '#human/llm/message';

const MAX_TITLE_LENGTH = 200;
const MAX_LAST_PROMPT_LENGTH = 4000;

export function titleFromPromptMetadataText(text: string): string {
  return text.slice(0, MAX_TITLE_LENGTH);
}

export function promptMetadataTextFromContentParts(
  parts: readonly ContentPart[],
  clientMetadata?: unknown,
): string | undefined {
  if (Array.isArray(clientMetadata) && clientMetadata.length > 0) {
    const displayTexts = clientMetadata.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return undefined;
      const text = (entry as { display_text?: unknown }).display_text;
      return typeof text === 'string' ? text : undefined;
    });
    if (displayTexts.every((text) => text !== undefined)) return promptMetadataTextFromText(displayTexts.join('\n'));
  }
  return promptMetadataTextFromText(promptDisplayTextFromContentParts(parts));
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

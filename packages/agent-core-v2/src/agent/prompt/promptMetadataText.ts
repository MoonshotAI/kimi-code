/**
 * `prompt` domain — safe, displayable metadata text derived from prompts.
 *
 * Shared by prompt submission and undo projection so `lastPrompt` uses one
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
    .replaceAll(
      /\b[A-Za-z0-9][A-Za-z0-9+/=_-]{39,}\b/g,
      (match: string, offset: number, source: string) => {
        const following = source.slice(offset + match.length);
        return isFileNameStem(match, following) || isPathLike(match, offset, source)
          ? match
          : '[redacted]';
      },
    )
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

  if (sanitized.length === 0) return undefined;
  return sanitized.slice(0, MAX_LAST_PROMPT_LENGTH);
}

const SAFE_FILENAME_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'css', 'scss', 'less', 'html', 'vue', 'svelte', 'php', 'sh', 'sql',
  'graphql', 'proto', 'lua', 'dart',
]);

function isFileNameStem(stem: string, following: string): boolean {
  if (!/^(?=.*[-_])[a-z0-9_-]+$/.test(stem)) return false;
  return safeSuffixFollows(following);
}

function safeSuffixFollows(following: string): boolean {
  const suffix = /^((?:\.[A-Za-z0-9]{1,8})+)(?![.A-Za-z0-9+/=_-])/.exec(following)?.[1];
  if (suffix === undefined) return false;
  const extension = suffix.slice(suffix.lastIndexOf('.') + 1);
  return SAFE_FILENAME_EXTENSIONS.has(extension.toLowerCase());
}

function isPathLike(match: string, offset: number, source: string): boolean {
  if (!match.includes('/')) return false;
  const segments = match.split('/');
  const directories = segments.slice(0, -1);
  const base = segments[segments.length - 1];
  if (!directories.every(isWordShapedSegment)) return false;
  const following = source.slice(offset + match.length);
  if (isFileNameStem(base, following)) return true;
  if (base.length < 40 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(base) && safeSuffixFollows(following)) {
    return true;
  }
  if (!isWordShapedSegment(base)) return false;
  if (segments.length < 3 || !segments.every((segment) => segment.length <= 24)) return false;
  if (offset === 0 || source[offset - 1] !== '/') return false;
  return PATH_ROOT_SEGMENTS.has(segments[0]) || source[offset - 2] === '~';
}

const PATH_ROOT_SEGMENTS = new Set([
  'Users', 'Volumes', 'home', 'tmp', 'var', 'opt', 'usr', 'etc', 'root', 'mnt',
  'media', 'srv',
]);

function isWordShapedSegment(segment: string): boolean {
  return segment.length < 40 && /^([A-Z]?[a-z0-9_-]*|[A-Z0-9_-]+)$/.test(segment);
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

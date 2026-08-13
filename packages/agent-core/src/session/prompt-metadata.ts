import type { ActivatePluginCommandPayload, ActivateSkillPayload, PromptPayload } from '#/rpc';
import { extractImageCompressionCaptions } from '#/tools/support/image-compress';
import type { ContentPart } from '@moonshot-ai/kosong';

const MAX_TITLE_LENGTH = 200;
const MAX_LAST_PROMPT_LENGTH = 4000;

export function titleFromPromptMetadataText(text: string): string {
  return text.slice(0, MAX_TITLE_LENGTH);
}

export function promptMetadataTextFromPayload(payload: PromptPayload): string | undefined {
  const parts: string[] = [];
  for (const part of payload.input) {
    const text = promptPartText(part);
    if (text !== undefined) parts.push(text);
  }
  return sanitizeAndTruncatePromptText(parts.join('\n'), MAX_LAST_PROMPT_LENGTH);
}

export function promptMetadataTextFromSkill(payload: ActivateSkillPayload): string | undefined {
  const args = payload.args?.trim();
  return sanitizeAndTruncatePromptText(
    args === undefined || args.length === 0 ? `/${payload.name}` : `/${payload.name} ${args}`,
    MAX_LAST_PROMPT_LENGTH,
  );
}

export function promptMetadataTextFromPluginCommand(
  payload: ActivatePluginCommandPayload,
): string | undefined {
  const args = payload.args?.trim();
  const command = `/${payload.pluginId}:${payload.commandName}`;
  return sanitizeAndTruncatePromptText(
    args === undefined || args.length === 0 ? command : `${command} ${args}`,
    MAX_LAST_PROMPT_LENGTH,
  );
}

function promptPartText(part: ContentPart): string | undefined {
  switch (part.type) {
    case 'text': {
      // Prompt ingestion may have annotated a compressed image with an inline
      // caption (see buildImageCompressionCaption). It is harness metadata,
      // not something the user typed, so keep it out of titles/lastPrompt.
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

function sanitizeAndTruncatePromptText(text: string, maxLength: number): string | undefined {
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
      (match: string, offset: number, source: string) =>
        isFileNameStem(match, source.slice(offset + match.length)) ? match : '[redacted]',
    )
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

  if (sanitized.length === 0) return undefined;
  return sanitized.slice(0, maxLength);
}

// Extensions that mark a long token-shaped word as a human-named file stem.
// Secret-carrier formats (env/json/yaml/pem/key/...) are excluded on purpose:
// this sanitizer is a privacy boundary and fails closed.
const SAFE_FILENAME_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'css', 'scss', 'less', 'html', 'vue', 'svelte', 'php', 'sh', 'sql',
  'graphql', 'proto', 'lua', 'dart',
]);

// A long token-shaped word stays readable only as the stem of a human-named
// slug (contains `-`/`_`) of a text/code file, e.g.
// `refact-000-08-12-external-hooks-feature-scopes.test.ts`. Compound suffixes
// are judged by their final component; a dotted segment longer than 8
// alphanumerics (e.g. a JWT segment) is not an extension, and anything that
// continues with another dot or token character after the suffix is not a
// file name either.
function isFileNameStem(stem: string, following: string): boolean {
  if (!/[-_]/.test(stem)) return false;
  const suffix = /^((?:\.[A-Za-z0-9]{1,8})+)(?![.A-Za-z0-9+/=_-])/.exec(following)?.[1];
  if (suffix === undefined) return false;
  const extension = suffix.slice(suffix.lastIndexOf('.') + 1);
  return SAFE_FILENAME_EXTENSIONS.has(extension.toLowerCase());
}

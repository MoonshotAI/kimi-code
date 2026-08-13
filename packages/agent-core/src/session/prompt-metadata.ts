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
// slug of a text/code file, e.g.
// `refact-000-08-12-external-hooks-feature-scopes.test.ts`. The stem must be
// all-lowercase slug characters (`a-z0-9_-`) with at least one `-`/`_`
// separator — machine-generated tokens are mixed-case with overwhelming
// probability and never qualify — and a safe extension must follow.
function isFileNameStem(stem: string, following: string): boolean {
  if (!/^(?=.*[-_])[a-z0-9_-]+$/.test(stem)) return false;
  return safeSuffixFollows(following);
}

// A dotted suffix counts as a file extension only when its final component
// is a safe text/code extension; a dotted segment longer than 8
// alphanumerics (e.g. a JWT segment) is not an extension, and anything that
// continues with another dot or token character after the suffix is not a
// file name either.
function safeSuffixFollows(following: string): boolean {
  const suffix = /^((?:\.[A-Za-z0-9]{1,8})+)(?![.A-Za-z0-9+/=_-])/.exec(following)?.[1];
  if (suffix === undefined) return false;
  const extension = suffix.slice(suffix.lastIndexOf('.') + 1);
  return SAFE_FILENAME_EXTENSIONS.has(extension.toLowerCase());
}

// A long token-shaped word also stays readable as a path, absolute or
// relative, e.g. `/Users/.../refact-...-scopes.ts` or `src/.../README.md`.
// Every directory segment must stay below the 40-char token threshold and
// look like a human-named word (lowercase, Capitalized, or ALL-CAPS like
// `README`). The basename is more flexible: a long slug must pass the strict
// file-name rule above, but below the token threshold it cannot be a
// catch-all secret on its own, so normal code-file casing (camelCase /
// PascalCase / kebab / snake) with a safe suffix stays readable. An
// extensionless match needs stronger local-path context — rooted at a
// well-known filesystem root (or `~/`) with at least three segments, each no
// longer than a natural directory name — so slash-joined token material like
// `<20 lowercase chars>/<20 lowercase chars>/<20 lowercase chars>` fails
// closed, as do mixed-case random segments and token-length basenames (e.g.
// `/tmp/<48-char token>`).
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
  return PATH_ROOT_SEGMENTS.has(segments[0].toLowerCase()) || source[offset - 2] === '~';
}

// Well-known filesystem roots that anchor an extensionless absolute path.
const PATH_ROOT_SEGMENTS = new Set([
  'users', 'home', 'tmp', 'var', 'opt', 'usr', 'etc', 'root', 'mnt', 'media',
  'volumes', 'data', 'srv',
]);

function isWordShapedSegment(segment: string): boolean {
  return segment.length < 40 && /^([A-Z]?[a-z0-9_-]*|[A-Z0-9_-]+)$/.test(segment);
}

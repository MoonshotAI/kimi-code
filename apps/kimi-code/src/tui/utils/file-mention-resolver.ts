/**
 * Resolve `@path` / `@"quoted path"` mentions in submitted text to real
 * absolute paths on disk, and fold that grounding into the text sent to the
 * model.
 *
 * The autocomplete dropdown (`FileMentionProvider`) only ever inserts a
 * literal path string — there is no accompanying signal that tells the model
 * "this exact file exists here". Without it, the agent has to rediscover a
 * mentioned file itself with `ls`/`find` before it can act on it, even when
 * the mention already points straight at it (see #2688). Appending resolved
 * absolute paths closes that gap without changing what the user sees in
 * their own message — only the SDK-bound text gains the annotation, the same
 * way media placeholders expand into separate prompt parts.
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const PATH_DELIMITERS = new Set([' ', '\t', '\n', '\r', '"', "'", '=']);
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

export interface MentionResolution {
  readonly mention: string;
  readonly absolutePath: string;
  readonly isDirectory: boolean;
}

export function resolveFileMentions(
  text: string,
  workDir: string,
  additionalDirs: readonly string[],
): readonly MentionResolution[] {
  const resolutions: MentionResolution[] = [];
  const seen = new Set<string>();
  const roots = [workDir, ...additionalDirs];

  let i = 0;
  while (i < text.length) {
    const isAtTokenStart = text[i] === '@' && (i === 0 || PATH_DELIMITERS.has(text[i - 1] ?? ''));
    if (!isAtTokenStart) {
      i += 1;
      continue;
    }
    const { raw, end } = readMentionToken(text, i);
    i = end;
    if (raw.length === 0 || seen.has(raw)) continue;
    seen.add(raw);
    const resolved = resolveMentionPath(raw, roots);
    if (resolved !== null) resolutions.push({ mention: `@${raw}`, ...resolved });
  }

  return resolutions;
}

function readMentionToken(text: string, atIndex: number): { raw: string; end: number } {
  const quoteStart = atIndex + 1;
  if (text[quoteStart] === '"') {
    const closeIndex = text.indexOf('"', quoteStart + 1);
    if (closeIndex === -1) return { raw: '', end: text.length };
    return { raw: text.slice(quoteStart + 1, closeIndex), end: closeIndex + 1 };
  }

  let i = quoteStart;
  while (i < text.length && !PATH_DELIMITERS.has(text[i] ?? '')) i += 1;
  const untrimmed = text.slice(quoteStart, i);
  const raw = untrimmed.replace(TRAILING_PUNCTUATION, '');
  return { raw, end: quoteStart + raw.length };
}

function resolveMentionPath(
  raw: string,
  roots: readonly string[],
): { absolutePath: string; isDirectory: boolean } | null {
  const expanded =
    raw === '~' ? homedir() : raw.startsWith('~/') ? resolve(homedir(), raw.slice(2)) : raw;
  const candidates = isAbsolute(expanded) ? [expanded] : roots.map((root) => resolve(root, expanded));

  for (const candidate of candidates) {
    try {
      const stats = statSync(candidate);
      return { absolutePath: candidate, isDirectory: stats.isDirectory() };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The user's message unchanged, plus a grounding block naming the resolved
 * absolute path for every mention that actually exists on disk. Returns
 * `text` unmodified when nothing resolved, so callers can cheaply detect
 * "nothing to enrich" with a reference check.
 */
export function buildTextWithResolvedMentions(
  text: string,
  workDir: string,
  additionalDirs: readonly string[],
): string {
  const resolutions = resolveFileMentions(text, workDir, additionalDirs);
  if (resolutions.length === 0) return text;

  const lines = resolutions.map(
    (r) => `- ${r.mention} -> ${r.absolutePath}${r.isDirectory ? ' (directory)' : ''}`,
  );
  return `${text}\n\n<mentioned-files>\n${lines.join('\n')}\n</mentioned-files>`;
}

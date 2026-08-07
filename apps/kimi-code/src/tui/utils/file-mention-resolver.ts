/**
 * Resolve `@path` / `@"quoted path"` mentions in submitted text to real
 * absolute paths on disk, and turn that into a standalone grounding part
 * appended alongside whatever else is sent for the turn.
 *
 * The autocomplete dropdown (`FileMentionProvider`) only ever inserts a
 * literal path string — there is no accompanying signal that tells the model
 * "this exact file exists here". Without it, the agent has to rediscover a
 * mentioned file itself with `ls`/`find` before it can act on it, even when
 * the mention already points straight at it (see #2688).
 *
 * The grounding part is wrapped in `<mentioned-files>` so it stays out of the
 * user-visible transcript entry (built from the original `text`, not from
 * these parts) and is easy to scrub back out wherever persisted prompt
 * content is turned back into display text — see `MENTIONED_FILES_PATTERN`
 * and its uses in `message-replay.ts` and (mirrored, cross-package)
 * `promptMetadataText.ts`.
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';

const PATH_DELIMITERS = new Set([' ', '\t', '\n', '\r', '"', "'", '=']);
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

/** Matches a whole grounding block produced by {@link mentionGroundingPart}. */
export const MENTIONED_FILES_PATTERN = /<mentioned-files>[\s\S]*?<\/mentioned-files>/g;

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
 * A standalone text part naming the resolved absolute path for every
 * `@mention` in `text` that actually exists on disk, or `undefined` when
 * nothing resolved. Append it to whatever parts are already being sent
 * (plain text, or text + media) — never send it alone, since it carries no
 * meaning without the message it's grounding.
 */
export function mentionGroundingPart(
  text: string,
  workDir: string,
  additionalDirs: readonly string[],
): PromptPart | undefined {
  const resolutions = resolveFileMentions(text, workDir, additionalDirs);
  if (resolutions.length === 0) return undefined;

  const lines = resolutions.map(
    (r) => `- ${r.mention} -> ${r.absolutePath}${r.isDirectory ? ' (directory)' : ''}`,
  );
  return { type: 'text', text: `<mentioned-files>\n${lines.join('\n')}\n</mentioned-files>` };
}

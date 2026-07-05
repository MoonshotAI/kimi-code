/**
 * Submit-time resolution of `@` file mentions.
 *
 * The `@path` token is an input affordance: the editor's autocomplete
 * inserts `@relative/path` (or `@"path with spaces"`), but the `@` is
 * only meaningful to the harness — the model must never see it as a
 * literal part of a file name. Resolution is existence-gated: a token
 * that resolves to a real file or directory is rewritten to its
 * absolute path (stripping the `@`); anything else (npm scopes like
 * `@types/node`, emails, plain prose) passes through untouched.
 *
 * Tokenization mirrors the editor's mention autocomplete
 * (`extractAtPrefix` in file-mention-provider.ts): a mention starts at
 * `@` preceded by start-of-text or a delimiter, and runs until the next
 * delimiter — or, for `@"..."`, until the closing quote.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/**
 * Characters that end an unquoted mention token. Superset of the
 * editor autocomplete's PATH_DELIMITERS (adds newlines, which a
 * single-line completion context never sees but submitted multi-line
 * text can contain). Keep in sync with file-mention-provider.ts.
 */
export const MENTION_DELIMITERS: ReadonlySet<string> = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '"',
  "'",
  '=',
]);

/**
 * Trailing punctuation (ASCII + CJK) retried without when the raw token
 * does not resolve — covers `看看 @报告.docx。` style sentences where
 * the full stop glues onto the token. Punctuation-only suffixes: a
 * character run containing letters/digits (e.g. a real extension) never
 * matches, so `@foo.md` is not truncated to `foo`.
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>。，、；：！？）】》〉…]+$/;

/**
 * CJK sentence punctuation splits a token into retry prefixes: CJK prose
 * puts no space after a clause (`@a.ts，接着…`), so the token may run past
 * the path. ASCII `.`/`,` are NOT split points — they legitimately appear
 * inside file names (`main.ts`), and splitting there could mis-resolve a
 * missing `@src.md` onto an existing `src/`. CJK punctuation in real file
 * names is rare, and existence gating tries the full token first anyway.
 */
const CJK_PUNCTUATION = /[。，、；：！？）】》〉…　]/g;
const MAX_SPLIT_CANDIDATES = 8;

export interface ResolvedFileMention {
  /** The literal token as typed, including `@` (and quotes if any). */
  readonly raw: string;
  /** Absolute filesystem path the token resolved to. */
  readonly absolutePath: string;
}

export interface FileMentionResolution {
  /** Input text with every resolved mention rewritten to its absolute path. */
  readonly text: string;
  /** Resolved mentions in the order they appeared; empty when none hit. */
  readonly mentions: readonly ResolvedFileMention[];
}

/**
 * Rewrite existence-verified `@` mentions in `text` to absolute paths.
 *
 * `workDir` must be the same base the mention autocomplete scans
 * (appState.workDir) so that every path the completion inserted is
 * guaranteed to resolve here.
 */
export function resolveFileMentions(text: string, workDir: string): FileMentionResolution {
  const mentions: ResolvedFileMention[] = [];
  let out = '';
  let cursor = 0;

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@') continue;
    if (i > 0 && !MENTION_DELIMITERS.has(text[i - 1] ?? '')) continue;

    const token = readMentionToken(text, i);
    if (token === null) continue;

    const hit = resolveCandidate(token.candidates, workDir);
    if (hit === null) {
      i += token.rawLength - 1;
      continue;
    }

    out += text.slice(cursor, i);
    out += formatResolvedPath(hit.absolutePath);
    mentions.push({ raw: text.slice(i, i + hit.consumedLength), absolutePath: hit.absolutePath });
    cursor = i + hit.consumedLength;
    i = cursor - 1;
  }

  if (mentions.length === 0) return { text, mentions };
  out += text.slice(cursor);
  return { text: out, mentions };
}

interface MentionToken {
  /** Total length of the token including `@` (and quotes if any). */
  readonly rawLength: number;
  /**
   * Path candidates to try in order, longest first. Each carries the
   * token length it would consume when it resolves, so punctuation
   * dropped by the retry stays in the surrounding text.
   */
  readonly candidates: readonly { path: string; consumedLength: number }[];
}

function readMentionToken(text: string, atIndex: number): MentionToken | null {
  // Quoted form: @"path with spaces" — consume through the closing quote.
  if (text[atIndex + 1] === '"') {
    const close = text.indexOf('"', atIndex + 2);
    if (close === -1) return null;
    const inner = text.slice(atIndex + 2, close);
    if (inner.length === 0) return null;
    return {
      rawLength: close + 1 - atIndex,
      candidates: [{ path: inner, consumedLength: close + 1 - atIndex }],
    };
  }

  let end = atIndex + 1;
  while (end < text.length && !MENTION_DELIMITERS.has(text[end] ?? '')) end += 1;
  const token = text.slice(atIndex + 1, end);
  if (token.length === 0) return null;

  // Longest candidate first: the full token, then progressively shorter
  // retries (trailing punctuation stripped, prefixes cut at CJK
  // punctuation). Existence gating picks the first that resolves.
  const paths = [token];
  const trimmed = token.replace(TRAILING_PUNCTUATION, '');
  if (trimmed.length > 0 && trimmed !== token) paths.push(trimmed);
  CJK_PUNCTUATION.lastIndex = 0;
  const splitOffsets: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = CJK_PUNCTUATION.exec(token)) !== null) {
    if (match.index === 0) break;
    splitOffsets.push(match.index);
    if (splitOffsets.length >= MAX_SPLIT_CANDIDATES) break;
  }
  for (const offset of splitOffsets.toReversed()) {
    paths.push(token.slice(0, offset));
  }

  const seen = new Set<string>();
  const candidates: { path: string; consumedLength: number }[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    candidates.push({ path, consumedLength: 1 + path.length });
  }
  return { rawLength: 1 + token.length, candidates };
}

function resolveCandidate(
  candidates: readonly { path: string; consumedLength: number }[],
  workDir: string,
): { absolutePath: string; consumedLength: number } | null {
  for (const candidate of candidates) {
    const absolutePath = toAbsolutePath(candidate.path, workDir);
    if (existsSync(absolutePath)) {
      return { absolutePath, consumedLength: candidate.consumedLength };
    }
  }
  return null;
}

function toAbsolutePath(path: string, workDir: string): string {
  if (path === '~' || path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }
  if (isAbsolute(path)) return resolve(path);
  return resolve(workDir, path);
}

/** Paths containing whitespace are quoted so the model sees one token. */
function formatResolvedPath(absolutePath: string): string {
  return /\s/.test(absolutePath) ? `"${absolutePath}"` : absolutePath;
}

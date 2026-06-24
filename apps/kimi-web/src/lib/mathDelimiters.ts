/**
 * Escape prose `$` characters so they are not mistaken for inline math.
 *
 * markstream renders `$…$` as inline math once KaTeX is enabled, but its
 * tokenizer greedily pairs any two `$` characters with no notion of "this is a
 * price / env var / path, not a formula". Worse, that greedy pairing runs
 * *before* any token-level hook, so a prose dollar in front of a real formula
 * (`costs $5 and formula $x$`) steals the formula's opening `$`, and fixing it
 * after the fact can only blank the span — the later formula is lost.
 *
 * So we fix it at the source: a `$` is only a math delimiter when it has a
 * valid partner under the two widely-used industry rules:
 *
 *   - Pandoc (`tex_math_dollars`): the opening `$` must be followed by a
 *     non-space, the closing `$` must be preceded by a non-space.
 *   - GitHub-style outer boundary: each `$` must not be glued to an ASCII
 *     letter or digit on its outer side (whitespace, line boundaries, and any
 *     other character — including CJK punctuation/ideographs and curly quotes
 *     — are valid boundaries).
 *
 * `$` characters that fail to form a valid pair are escaped as `\$`, which the
 * tokenizer leaves as a literal dollar. Code spans, fenced code blocks, and
 * `$$…$$` display math are left untouched.
 */
const FENCED_CODE_RE = /(^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}\2[ \t]*(?=\n|$))/gm;
const INLINE_CODE_RE = /(`+)(?=[^`])[\s\S]*?\1/g;
const BLOCK_MATH_RE = /\$\$[\s\S]*?\$\$/g;
// A 4-space / tab indented line is a Markdown indented code block; protect
// each such line so its dollars are not rewritten (code renders backslashes
// literally, so `\$HOME` would show instead of `$HOME`).
const INDENTED_CODE_RE = /^(?: {4}|\t)[^\n]*/gm;
const PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;
const ASCII_ALNUM = /[A-Za-z0-9]/;

/** Replace protected regions (code / display math) with opaque placeholders. */
function protect(src: string): { text: string; protected: string[] } {
  const stash: string[] = [];
  const save = (match: string) => {
    stash.push(match);
    return `\u0000${stash.length - 1}\u0000`;
  };
  let text = src.replace(FENCED_CODE_RE, save);
  text = text.replace(INDENTED_CODE_RE, save);
  text = text.replace(INLINE_CODE_RE, save);
  text = text.replace(BLOCK_MATH_RE, save);
  return { text, protected: stash };
}

function restore(text: string, stash: string[]): string {
  // Protected regions can nest (e.g. inline code that looks like display math,
  // or an indented line containing a code span), so a single pass may leave
  // placeholders inside a just-restored region. Repeat until stable.
  let prev = '';
  while (prev !== text) {
    prev = text;
    text = text.replace(PLACEHOLDER_RE, (_, n) => stash[Number(n)] ?? '');
  }
  return text;
}

/** A `$` at `i` can open inline math: tight on the right, bounded on the left. */
function isValidOpen(text: string, i: number): boolean {
  const after = text[i + 1];
  if (after === undefined || /\s/.test(after) || after === '$') return false;
  const before = text[i - 1];
  if (before !== undefined && ASCII_ALNUM.test(before)) return false;
  return true;
}

/**
 * The index of the `$` that closes an opener at `openIdx`, or -1 if the nearest
 * candidate is not a valid closer (so the opener is prose). We only consider
 * the nearest `$`: any other `$` in between would be prose that itself failed
 * to pair, and skipping it would over-span real text.
 */
function findValidClose(text: string, openIdx: number): number {
  const closeIdx = text.indexOf('$', openIdx + 1);
  if (closeIdx === -1) return -1;
  const before = text[closeIdx - 1];
  if (before === undefined || /\s/.test(before)) return -1;
  const after = text[closeIdx + 1];
  if (after !== undefined && ASCII_ALNUM.test(after)) return -1;
  return closeIdx;
}

/** Pair valid `$…$` spans and escape every other `$` as `\$`. */
function pairAndEscape(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '$') {
      out += '\\$';
      i += 2;
      continue;
    }
    if (ch !== '$') {
      out += ch;
      i++;
      continue;
    }
    if (!isValidOpen(text, i)) {
      out += '\\$';
      i++;
      continue;
    }
    const closeIdx = findValidClose(text, i);
    if (closeIdx === -1) {
      out += '\\$';
      i++;
      continue;
    }
    out += text.slice(i, closeIdx + 1);
    i = closeIdx + 1;
  }
  return out;
}

export function escapeProseDollars(src: string): string {
  if (!src.includes('$')) return src;
  const { text, protected: stash } = protect(src);
  return restore(pairAndEscape(text), stash);
}

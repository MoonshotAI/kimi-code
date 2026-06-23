import type { MarkdownToken } from 'markstream-vue';

// Characters that may sit immediately OUTSIDE a `$` delimiter while still
// treating it as math — i.e. structural punctuation, not a prose token. A
// letter or digit here means a second prose token (`$PATH:$HOME`, `$5/$10`).
//   - left of an opening `$`: whitespace / line boundary / opening brackets.
//   - right of a closing `$`: whitespace / line boundary / sentence or closing
//     punctuation (so `$x^2$.` and `($x$)` still render).
const LEFT_BOUNDARY = /[\s([{]/;
const RIGHT_BOUNDARY = /[\s.,;:!?)\]}]/;

function isLeftBoundary(char: string | undefined): boolean {
  return !char || LEFT_BOUNDARY.test(char);
}

function isRightBoundary(char: string | undefined): boolean {
  return !char || RIGHT_BOUNDARY.test(char);
}

/**
 * True when a single-`$` inline span is almost certainly plain prose dollars,
 * not a real LaTeX formula. Combines the two widely-used industry rules:
 *
 *   - Pandoc (`tex_math_dollars`): no whitespace immediately inside the
 *     delimiters — catches `Check $PATH before $HOME`, `costs $5 and $10`.
 *   - GitHub: each `$` must be bounded on its outer side by whitespace, a line
 *     boundary, or structural punctuation — catches compact prose where a
 *     second token touches the closing `$`, such as `costs $5/$10`,
 *     `Use $HOME/bin:$PATH`, or `$foo_$bar`.
 *
 * `prevChar` / `nextChar` are the characters immediately before the opening `$`
 * and after the closing `$`, taken from the neighbouring text tokens.
 */
function isProseDollarSpan(
  content: string,
  prevChar: string | undefined,
  nextChar: string | undefined,
): boolean {
  if (/^\s|\s$/.test(content)) return true;
  if (!isLeftBoundary(prevChar)) return true;
  if (!isRightBoundary(nextChar)) return true;
  return false;
}

/**
 * Guard ordinary prose dollars from being rendered as KaTeX inline math.
 *
 * markstream renders `$…$` as inline math once KaTeX is enabled, but its
 * tokenizer is lax — it mechanically pairs any two `$` characters — so prose
 * like `Check $PATH before $HOME`, `costs $5/$10`, and
 * `Use $HOME/bin:$PATH` all get swallowed as one formula instead of readable
 * text.
 *
 * A single-`$` span that looks like prose (see isProseDollarSpan) is turned
 * back into literal `$…$` text. Block `$$…$$` math and tight inline math are
 * left untouched.
 *
 * This runs on the flat markdown-it token stream, so it also covers dollars
 * nested inside lists and blockquotes (their `inline` tokens sit at the top
 * level of the stream). Code spans are already excluded by the tokenizer.
 */
export function guardLiteralDollarMath(tokens: MarkdownToken[]): MarkdownToken[] {
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    const children = token.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.type !== 'math_inline' || child.markup !== '$') continue;

      const prev = children[i - 1];
      const next = children[i + 1];
      const prevChar = prev?.type === 'text' ? prev.content?.slice(-1) : undefined;
      const nextChar = next?.type === 'text' ? next.content?.charAt(0) : undefined;

      if (isProseDollarSpan(child.content ?? '', prevChar, nextChar)) {
        child.type = 'text';
        child.markup = '';
        child.content = `$${child.content ?? ''}$`;
        child.children = null;
      }
    }
  }
  return tokens;
}

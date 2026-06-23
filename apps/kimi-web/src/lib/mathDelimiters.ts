import type { MarkdownToken } from 'markstream-vue';

// A numeric amount with a trailing range connector, e.g. the `5/` in
// `$5/$10` or the `5-` in `$5-$10`. A complete formula never ends in a
// dangling operator, so this is a compact prose range rather than math.
// Scoped to digit-led content so symbolic math like `$\frac{a}{b}-$` is left
// alone. The library already rejects `-`/`~` ranges, but not `/`, so we
// cover the full set here for defense in depth.
const TRAILING_RANGE_CONNECTOR = /^\d[\d,.]*\s*[-/~–—]\s*$/;

/**
 * True when a single-`$` inline span is almost certainly plain prose dollars,
 * not a real LaTeX formula.
 *
 * Real inline math is written tight (`$E=mc^2$`, `$\frac{1}{2}$`), so:
 *   - whitespace inside the delimiters (`PATH before `, `5 and `) means prose
 *     like `Check $PATH before $HOME` or `costs $5 and $10`;
 *   - a number with a trailing range connector (`5/`, `5-`) means a compact
 *     prose range like `costs $5/$10` or `costs $5-$10`.
 */
function isProseDollarSpan(content: string): boolean {
  if (/^\s|\s$/.test(content)) return true;
  if (TRAILING_RANGE_CONNECTOR.test(content.trim())) return true;
  return false;
}

/**
 * Guard ordinary prose dollars from being rendered as KaTeX inline math.
 *
 * markstream renders `$…$` as inline math once KaTeX is enabled, but its
 * tokenizer is lax: it has no "no whitespace inside the delimiters" rule and
 * only rejects `-`/`~` currency ranges, so prose like
 * `Check $PATH before $HOME`, `costs $5 and $10`, and `costs $5/$10` all get
 * swallowed as one formula instead of readable text.
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
    for (const child of token.children) {
      if (
        child.type === 'math_inline' &&
        child.markup === '$' &&
        isProseDollarSpan(child.content ?? '')
      ) {
        child.type = 'text';
        child.markup = '';
        child.content = `$${child.content ?? ''}$`;
        child.children = null;
      }
    }
  }
  return tokens;
}

import type { MarkdownToken } from 'markstream-vue';

/**
 * Guard ordinary prose dollars from being rendered as KaTeX inline math.
 *
 * markstream renders `$…$` as inline math once KaTeX is enabled, but its
 * tokenizer has no "no whitespace inside the delimiters" rule, so two
 * dollar-prefixed tokens in plain prose get swallowed as one formula —
 * `Check $PATH before $HOME` and `costs $5 and $10` both render as math
 * instead of readable text.
 *
 * Real inline math is written tight (`$E=mc^2$`, `$\frac{1}{2}$`), while the
 * prose false-positives always have whitespace inside the delimiters
 * (`PATH before `, `5 and `). So a single-`$` span whose content starts or
 * ends with whitespace is treated as literal `$…$` text again. Block `$$…$$`
 * math and tight inline math are left untouched.
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
        /^\s|\s$/.test(child.content ?? '')
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

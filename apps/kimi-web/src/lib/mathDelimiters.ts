import type { MarkdownToken } from 'markstream-vue';

// An ASCII letter or digit glued to the OUTSIDE of a `$` delimiter means a
// second prose token is attached (`$PATH:$HOME`, `$5/$10`, `$foo_$bar`), so
// the span is literal text, not math. Everything else — whitespace, line
// boundaries, and any non-ASCII-alphanumeric character — is a valid math
// boundary. That deliberately includes punctuation (ASCII and full-width/CJK),
// CJK ideographs, and curly/typographic quotes, so localized prose like
// `公式为 $E=mc^2$，其中` and quoted formulas like `“$x$”` still render.
const ASCII_ALNUM = /[A-Za-z0-9]/;

function touchesProseToken(char: string | undefined): boolean {
  return char !== undefined && ASCII_ALNUM.test(char);
}

/**
 * True when a single-`$` inline span is almost certainly plain prose dollars,
 * not a real LaTeX formula. Combines two widely-used industry rules:
 *
 *   - Pandoc (`tex_math_dollars`): no whitespace immediately inside the
 *     delimiters — catches `Check $PATH before $HOME`, `costs $5 and $10`.
 *   - GitHub-style outer boundary, generalized beyond ASCII: a `$` glued to an
 *     ASCII letter or digit means a second prose token, so the span is literal
 *     text. Catches compact prose like `costs $5/$10`, `Use $HOME/bin:$PATH`,
 *     and `$foo_$bar`, while still allowing CJK punctuation and quotes around
 *     real formulas.
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
  if (touchesProseToken(prevChar)) return true;
  if (touchesProseToken(nextChar)) return true;
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

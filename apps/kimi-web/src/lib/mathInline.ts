// apps/kimi-web/src/lib/mathInline.ts
import type { MarkdownIt } from 'markstream-vue';

// Inline math (`$…$`). markstream's built-in `math` rule is swapped for a
// conservative pandoc-style variant so `$…$` formulas (e.g. `$\Sigma_t$`)
// render through KaTeX without false-positiving on prices, env vars, and
// shell paths (`$5`, `$PATH`, `$HOME/bin`). Guards: the opening delimiter
// must be followed by a non-space character; a closing `$` must be preceded
// by a non-space, must not be followed by a digit, and the content must not
// be a bare number (currency) or contain a backtick. `$$…$$` and `\(...\)`
// inline forms are preserved, and `math_block` (the $$ block rule) is
// untouched. While streaming, an unclosed `$` still renders progressively —
// but only when the partial content is unambiguously TeX (see
// loadingInlineMath); anything else stays literal until it closes.
export interface MathInlineState {
  src: string;
  pos: number;
  env?: Record<string, unknown>;
  push: (
    type: string,
    tag: string,
    nesting: number,
  ) => { content: string; markup: string; raw?: string; loading?: boolean };
}

function isEscapedAt(src: string, idx: number): boolean {
  let count = 0;
  for (let i = idx - 1; i >= 0 && src[i] === '\\'; i--) count++;
  return count % 2 === 1;
}

// Currency amounts (`$5`, `$1,000.50`) are text, not math.
const BARE_NUMBER_RE = /^\d[\d,]*(?:\.\d+)?$/;

// Signal for progressive (streaming) rendering: a backslash command is the
// one TeX signal with zero overlap with prices and shell syntax — `_`, `^`,
// `=`, and `{}` all appear in env vars and shell expansions (`$MY_VAR`,
// `$PATH=$HOME`, `${PATH}`), so they would flash shell text as math.
const TEX_COMMAND_RE = /\\[a-zA-Z]/;

// Streaming best-effort: no closing `$` yet. Render progressively only when
// the partial content is unambiguously TeX; MathInlineNode falls back to the
// raw source when KaTeX can't parse a partial formula, so a half-typed
// `$\Sigma_` degrades gracefully. Settled messages (`__markstreamFinal`)
// never take this branch — an unclosed `$` there stays literal forever.
function loadingInlineMath(state: MathInlineState, silent: boolean): boolean {
  if (state.env?.__markstreamFinal) return false;
  const rest = state.src.slice(state.pos + 1);
  // Stop at the first line break so trailing prose isn't swallowed.
  const nl = rest.indexOf('\n');
  const partial = nl === -1 ? rest : rest.slice(0, nl);
  if (!TEX_COMMAND_RE.test(partial) || partial.includes('`')) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = partial;
    token.markup = '$';
    token.raw = state.src.slice(state.pos, state.pos + 1 + partial.length);
    token.loading = true;
  }
  state.pos = state.pos + 1 + partial.length;
  return true;
}

export function mathInline(state: MathInlineState, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;

  let openLen = 0;
  let close = '';
  if (src.startsWith('\\(', pos)) {
    openLen = 2;
    close = '\\)';
  } else if (src[pos] === '$') {
    if (src[pos + 1] === '$') {
      openLen = 2;
      close = '$$';
    } else {
      openLen = 1;
      close = '$';
    }
  } else {
    return false;
  }

  // pandoc rule: the opening delimiter must be followed by a non-space.
  const first = src[pos + openLen];
  if (first === undefined || /\s/.test(first)) return false;

  let end = pos + openLen;
  for (;;) {
    end = src.indexOf(close, end);
    if (end === -1) {
      // Streaming progressive render — single `$` only; `$$` blocks have
      // their own loading path in math_block, and `\(` is rare enough to
      // just wait for its close.
      if (close === '$') return loadingInlineMath(state, silent);
      return false;
    }
    if (isEscapedAt(src, end)) {
      end += close.length;
      continue;
    }
    if (close === '$') {
      // A `$` that fails the closer rules (part of a `$$` pair, preceded by
      // a space, or followed by a digit) ABANDONS this opener instead of
      // being skipped: scanning past it would let a literal dollar consume
      // the closer of a later formula (`Costs $5 and variable $x$` must not
      // become one math span). Abandoning keeps math content free of
      // unescaped `$` — spans never cross.
      if (
        src[end + 1] === '$' ||
        src[end - 1] === '$' ||
        /\s/.test(src[end - 1] ?? '') ||
        /\d/.test(src[end + 1] ?? '')
      ) {
        return false;
      }
    }
    break;
  }

  const content = src.slice(pos + openLen, end);
  if (!content.trim() || content.includes('`')) return false;
  if (close === '$' && BARE_NUMBER_RE.test(content.trim())) return false;

  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = content;
    token.markup = close === '\\)' ? '\\(\\)' : close;
    token.raw = src.slice(pos, end + close.length);
    token.loading = false;
  }
  state.pos = end + close.length;
  return true;
}

export function enableInlineMath(md: MarkdownIt): MarkdownIt {
  md.inline.ruler.at('math', mathInline);
  return md;
}

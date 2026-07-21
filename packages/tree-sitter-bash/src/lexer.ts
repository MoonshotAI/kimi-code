// src/lexer.ts
//
// Hand-written bash tokenizer. Produces a flat token stream of:
//
//   word      a maximal run of adjacent word material: bare characters,
//             '...' / "..." quotes, $var / ${...} / $(...) / `...` expansions,
//             <(...) / >(...) process substitutions. Quotes and substitutions
//             are skipped over with nesting awareness; the parser re-scans
//             the token range to build the actual sub-tree. The single
//             characters { } [ ] are emitted as their own word tokens (they
//             are not word characters in bash), matching tree-sitter-bash's
//             _special_character behaviour.
//   op        statement operators (&& || | |& ; ;; & ( )) and redirect
//             operators (< > >> >& <& &> &>> >| <> >&- <&- <<< << <<-).
//   io_number a run of digits immediately followed by < or > — the file
//             descriptor prefix of a redirect (2>/dev/null).
//   newline   a statement-terminating \n. Carries any heredoc bodies that
//             were queued on the lexer and are scanned right after the line.
//   comment   # ... to end of line (only at token start; # inside a word is
//             a plain word character).
//   eof       end of the lexer's range. Also carries pending heredoc bodies.
//
// The lexer is range-bounded: sub-parsers lex $(...) / `...` bodies with
// their own Lexer over the same source but a narrower [start, end) window.
//
// Heredoc queue: the parser registers a HeredocSpec for every << / <<- it
// accepts. When the lexer produces the next newline (or eof) token it scans
// one body per queued spec, in registration order, and attaches them to the
// token; the parser completes the matching heredoc_redirect nodes when it
// consumes that token.
//
// Budget: the lexer never creates nodes, so it only checks the deadline —
// once per produced token and periodically (every SCAN_TICK_INTERVAL
// characters) inside every long scan loop (word runs, quote/paren skipping,
// comments, blanks, heredoc bodies) — via budget.progress(), so a
// pathological single token cannot starve the deadline check. Node counting
// (budget.tick()) is the parser's job.

import type { ParseBudget } from '#/budget';
import { SPECIAL_VARIABLE_CHARS } from '#/grammar';

export type TokenType = 'word' | 'op' | 'io_number' | 'newline' | 'comment' | 'eof';

export interface Token {
  readonly type: TokenType;
  readonly start: number;
  readonly end: number;
  /** Heredoc bodies scanned when this newline/eof token was produced. */
  readonly heredocBodies: HeredocBody[];
}

export interface HeredocSpec {
  /** Delimiter text with any quoting removed — what must appear at line start. */
  readonly delimiter: string;
  /** `<<-`: leading tabs of the first body line are stripped. */
  readonly stripTabs: boolean;
  /** The delimiter was quoted ('EOF', "EOF", \EOF): the body is not expanded. */
  readonly quoted: boolean;
}

export interface HeredocBody {
  /** Start of the heredoc_body node (after first-line tab stripping). */
  readonly bodyStart: number;
  /** End of the heredoc_body node: right before the end marker, so the final
   *  newline and any tabs preceding the marker stay inside the body. */
  readonly bodyEnd: number;
  /** Start of the heredoc_end marker (the delimiter word itself). */
  readonly endStart: number;
  /** End of the heredoc_end marker. */
  readonly endEnd: number;
  /** False when the delimiter line never appeared: body runs to the end of
   *  the lexer's range and there is no heredoc_end. */
  readonly found: boolean;
}

/** How often long scan loops tick the budget, in scanned characters. */
const SCAN_TICK_INTERVAL = 2048;

const CONTROL_OPERATORS = ['&>>', '&>', '&&', '&', '|&', '||', '|', ';;', ';', '(', ')'] as const;
const REDIRECT_OPERATORS = ['<<-', '<<<', '<<', '<&-', '<&', '<>', '<', '>&-', '>&', '>>', '>|', '>'] as const;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w]/.test(ch);
}

function isBlank(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

function isDigitAt(source: string, i: number): boolean {
  const ch = source[i]!;
  return ch >= '0' && ch <= '9';
}

/** Skip a "..." quoted region starting at `i` (which points at the opening
 *  quote). Returns the index just past the closing quote, or `end` when the
 *  string is unterminated. Substitution-aware: $(...), ${...} and `...`
 *  inside the string may themselves contain quotes. */
export function skipDoubleQuoted(source: string, budget: ParseBudget, i: number, end: number): number {
  let j = i + 1;
  let sinceTick = 0;
  while (j < end) {
    if (++sinceTick >= SCAN_TICK_INTERVAL) {
      budget.progress();
      sinceTick = 0;
    }
    const ch = source[j]!;
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '"') return j + 1;
    if (ch === '`') {
      j = skipBacktick(source, budget, j, end);
      continue;
    }
    if (ch === '$') {
      const next = source[j + 1];
      if (next === '(') {
        j = scanBalanced(source, budget, j + 1, end, '(', ')').end;
        continue;
      }
      if (next === '{') {
        j = scanBalanced(source, budget, j + 1, end, '{', '}').end;
        continue;
      }
    }
    j++;
  }
  return end;
}

/** Skip a '...' region starting at `i`. No escapes exist in raw strings. */
export function skipSingleQuoted(source: string, _budget: ParseBudget, i: number, end: number): number {
  const close = source.indexOf("'", i + 1);
  if (close === -1 || close >= end) return end;
  return close + 1;
}

/** Skip a `...` region starting at `i`; \` is an escaped backtick. */
export function skipBacktick(source: string, budget: ParseBudget, i: number, end: number): number {
  let j = i + 1;
  let sinceTick = 0;
  while (j < end) {
    if (++sinceTick >= SCAN_TICK_INTERVAL) {
      budget.progress();
      sinceTick = 0;
    }
    const ch = source[j]!;
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '`') return j + 1;
    j++;
  }
  return end;
}

/** Result of scanning a balanced region. */
export interface BalancedScan {
  /** Index just past the matching close, or `end` when unbalanced. */
  end: number;
  /** Whether the matching close was actually found. */
  balanced: boolean;
}

/** Scan a balanced open/close region starting at `i` (which points at the
 *  opening character). Quote- and escape-aware. */
export function scanBalanced(
  source: string,
  budget: ParseBudget,
  i: number,
  end: number,
  open: string,
  close: string,
): BalancedScan {
  let depth = 0;
  let j = i;
  let sinceTick = 0;
  while (j < end) {
    if (++sinceTick >= SCAN_TICK_INTERVAL) {
      budget.progress();
      sinceTick = 0;
    }
    const ch = source[j]!;
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return { end: j + 1, balanced: true };
    } else if (ch === '"') {
      j = skipDoubleQuoted(source, budget, j, end);
      continue;
    } else if (ch === "'") {
      j = skipSingleQuoted(source, budget, j, end);
      continue;
    } else if (ch === '`') {
      j = skipBacktick(source, budget, j, end);
      continue;
    }
    j++;
  }
  return { end, balanced: false };
}

/** Skip a $-construct starting at `i` (which points at the `$`). Handles
 *  $(...), $((...)), ${...}, $name and the single-character specials. A `$`
 *  followed by anything else (including a quote) consumes just the `$`. */
export function skipDollar(source: string, budget: ParseBudget, i: number, end: number): number {
  const next = source[i + 1];
  if (next === '(') return scanBalanced(source, budget, i + 1, end, '(', ')').end;
  if (next === '{') return scanBalanced(source, budget, i + 1, end, '{', '}').end;
  if (isWordChar(next)) {
    let j = i + 1;
    while (j < end && isWordChar(source[j])) j++;
    return j;
  }
  if (next !== undefined && SPECIAL_VARIABLE_CHARS.includes(next)) return i + 2;
  return i + 1;
}

export class Lexer {
  /** Current scan position; exposed for the parser's heredoc bookkeeping. */
  pos: number;
  private lookahead: Token | null = null;
  private readonly pendingHeredocs: HeredocSpec[] = [];

  constructor(
    private readonly source: string,
    private readonly budget: ParseBudget,
    start = 0,
    private readonly end = source.length,
  ) {
    this.pos = start;
  }

  /** Queue a heredoc body to be scanned after the current line. */
  queueHeredoc(spec: HeredocSpec): void {
    this.pendingHeredocs.push(spec);
  }

  peek(): Token {
    this.lookahead ??= this.scanToken();
    return this.lookahead;
  }

  next(): Token {
    const token = this.peek();
    this.lookahead = null;
    return token;
  }

  text(token: Token): string {
    return this.source.slice(token.start, token.end);
  }

  private scanToken(): Token {
    this.budget.progress();
    this.skipBlanks();
    const start = this.pos;
    if (this.pos >= this.end) return this.scanBoundary('eof', start, start);
    const ch = this.source[this.pos]!;
    if (ch === '\n') {
      this.pos++;
      return this.scanBoundary('newline', start, this.pos);
    }
    if (ch === '#') {
      let sinceTick = 0;
      while (this.pos < this.end && this.source[this.pos] !== '\n') {
        if (++sinceTick >= SCAN_TICK_INTERVAL) {
          this.budget.progress();
          sinceTick = 0;
        }
        this.pos++;
      }
      return { type: 'comment', start, end: this.pos, heredocBodies: [] };
    }
    if (ch === '<' || ch === '>') {
      // <( / >( start a process substitution, which is word material. The
      // heredoc operators were already excluded: <<( is << + ( …
      if (this.source[this.pos + 1] === '(') return this.scanWord();
      return this.scanOp(REDIRECT_OPERATORS);
    }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '(' || ch === ')') {
      return this.scanOp(CONTROL_OPERATORS);
    }
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']') {
      this.pos++;
      return { type: 'word', start, end: this.pos, heredocBodies: [] };
    }
    if (ch >= '0' && ch <= '9') {
      let i = this.pos;
      while (i < this.end && isDigitAt(this.source, i)) i++;
      const next = this.source[i];
      if (next === '<' || next === '>') {
        this.pos = i;
        return { type: 'io_number', start, end: i, heredocBodies: [] };
      }
      return this.scanWord();
    }
    return this.scanWord();
  }

  /** Produce a newline/eof token, scanning any queued heredoc bodies that
   *  start right after it. */
  private scanBoundary(type: 'newline' | 'eof', start: number, end: number): Token {
    const bodies: HeredocBody[] = [];
    while (this.pendingHeredocs.length > 0) {
      bodies.push(this.readHeredocBody(this.pendingHeredocs.shift()!));
    }
    return { type, start, end, heredocBodies: bodies };
  }

  private skipBlanks(): void {
    let sinceTick = 0;
    for (;;) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const ch = this.source[this.pos];
      if (isBlank(ch)) {
        this.pos++;
        continue;
      }
      // Line continuation is whitespace, not word material.
      if (ch === '\\' && this.source[this.pos + 1] === '\n') {
        this.pos += 2;
        continue;
      }
      return;
    }
  }

  private scanOp(table: readonly string[]): Token {
    const start = this.pos;
    for (const op of table) {
      if (this.source.startsWith(op, this.pos) && this.pos + op.length <= this.end) {
        this.pos += op.length;
        return { type: 'op', start, end: this.pos, heredocBodies: [] };
      }
    }
    // Unreachable for the callers above, but never loop forever.
    this.pos++;
    return { type: 'op', start, end: this.pos, heredocBodies: [] };
  }

  private scanWord(): Token {
    const start = this.pos;
    let i = this.pos;
    let sinceTick = 0;
    while (i < this.end) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const ch = this.source[i]!;
      if (isBlank(ch) || ch === '\n') break;
      if (ch === '&' || ch === '|' || ch === ';' || ch === '(' || ch === ')') break;
      if (ch === '{' || ch === '}' || ch === '[' || ch === ']') break;
      if (ch === '<' || ch === '>') {
        if (this.source[i + 1] === '(') {
          i = scanBalanced(this.source, this.budget, i + 1, this.end, '(', ')').end;
          continue;
        }
        break;
      }
      if (ch === '\\') {
        // A line continuation ends the run (it acts as whitespace); a lone
        // trailing backslash at end of range is consumed as word text.
        if (this.source[i + 1] === '\n') break;
        i += 2;
        continue;
      }
      if (ch === '"') {
        i = skipDoubleQuoted(this.source, this.budget, i, this.end);
        continue;
      }
      if (ch === "'") {
        i = skipSingleQuoted(this.source, this.budget, i, this.end);
        continue;
      }
      if (ch === '`') {
        i = skipBacktick(this.source, this.budget, i, this.end);
        continue;
      }
      if (ch === '$') {
        i = skipDollar(this.source, this.budget, i, this.end);
        continue;
      }
      i++;
    }
    if (i === start) i++; // defensive: never emit a zero-width word token
    this.pos = i;
    return { type: 'word', start, end: i, heredocBodies: [] };
  }

  /**
   * Scan one heredoc body, starting at the current position (right after the
   * newline that ended the command line). Matches tree-sitter-bash's layout:
   * for `<<-` only the first body line's leading tabs are stripped; the end
   * marker is the bare delimiter word and any tabs before it belong to the
   * body.
   */
  private readHeredocBody(spec: HeredocSpec): HeredocBody {
    let bodyStart = this.pos;
    if (spec.stripTabs) {
      while (bodyStart < this.end && this.source[bodyStart] === '\t') bodyStart++;
    }
    let lineStart = this.pos;
    while (lineStart < this.end) {
      this.budget.progress();
      let marker = lineStart;
      if (spec.stripTabs) {
        while (marker < this.end && this.source[marker] === '\t') marker++;
      }
      if (spec.delimiter.length > 0 && this.source.startsWith(spec.delimiter, marker)) {
        const after = marker + spec.delimiter.length;
        if (after >= this.end || this.source[after] === '\n') {
          this.pos = after;
          return { bodyStart, bodyEnd: marker, endStart: marker, endEnd: after, found: true };
        }
      }
      const newline = this.source.indexOf('\n', lineStart);
      if (newline === -1) break;
      lineStart = newline + 1;
    }
    // Unterminated: the body runs to the end of this lexer's range.
    this.pos = this.end;
    return { bodyStart, bodyEnd: this.end, endStart: this.end, endEnd: this.end, found: false };
  }
}

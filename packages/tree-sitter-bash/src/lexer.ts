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
// Additionally:
//   - `;&` and `;;&` are single op tokens (case_item fallthrough
//     terminators).
//   - `((...))` at token start is scanned as one word token (arithmetic
//     command / c-style for header), so the parser can re-scan the range
//     with its expression parser; the word ends right after the balanced
//     close and does not merge with following word characters.
//   - peekAt(n) looks arbitrarily far ahead (function_definition
//     detection); reposition(pos) rewinds the stream (test commands parse
//     their [[ ... ]] range character-wise and then resume tokenizing past
//     the closer).
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

/**
 * Depth cap for the scanBalanced ↔ skipDoubleQuoted mutual recursion
 * (`${a#"${a#"…` nests two scan frames per level). Beyond the cap the scan
 * reports "unbalanced", letting the parser degrade the construct with
 * hasError instead of overflowing the call stack. Sized above the parser's
 * own nesting guards (which trigger first for parser-driven recursion);
 * this cap only protects lexer-driven scans of pathological input.
 */
const MAX_SCAN_DEPTH = 1024;

const CONTROL_OPERATORS = ['&>>', '&>', '&&', '&', '|&', '||', '|', ';;&', ';;', ';&', ';', '(', ')'] as const;
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
 *  inside the string may themselves contain quotes. `depth` tracks the
 *  scanBalanced ↔ skipDoubleQuoted recursion (see MAX_SCAN_DEPTH). */
export function skipDoubleQuoted(source: string, budget: ParseBudget, i: number, end: number, depth = 0): number {
  if (depth >= MAX_SCAN_DEPTH) return end;
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
        j = scanBalancedStatements(source, budget, j + 1, end, depth + 1).end;
        continue;
      }
      if (next === '{') {
        j = scanBalanced(source, budget, j + 1, end, '{', '}', depth + 1).end;
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
 *  opening character). Quote- and escape-aware. `depth` tracks the
 *  scanBalanced ↔ skipDoubleQuoted recursion (see MAX_SCAN_DEPTH). */
export function scanBalanced(
  source: string,
  budget: ParseBudget,
  i: number,
  end: number,
  open: string,
  close: string,
  depth = 0,
): BalancedScan {
  if (depth >= MAX_SCAN_DEPTH) return { end, balanced: false };
  let nesting = 0;
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
      nesting++;
    } else if (ch === close) {
      nesting--;
      if (nesting === 0) return { end: j + 1, balanced: true };
    } else if (ch === '"') {
      j = skipDoubleQuoted(source, budget, j, end, depth + 1);
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

/** Words after which a `case` word opens a case_statement (statement
 *  position) rather than being an ordinary argument. */
const CASE_ENABLING_WORDS: ReadonlySet<string> = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do']);

/**
 * Case-aware variant of scanBalanced for `(` … `)` regions that may hold
 * full statements (command/process substitution bodies). A naive paren
 * count closes the region early on a case_item pattern (`a) 1;; esac`):
 * every item's `)` would decrement the depth. While a `case` is open (seen
 * in statement position, not yet closed by `esac`), a `)` at the paren
 * depth where the `case` started is a pattern close and does NOT count;
 * parens from other constructs inside the case (subshells, $(…), the
 * optional `(` of an item) balance themselves normally.
 *
 * Statement position is approximated lexically: `case` counts as a keyword
 * after `(`, `;`, `&`, `|`, a newline, `{`, or one of the compound
 * keywords in CASE_ENABLING_WORDS — so `echo case` does not confuse the
 * scan. `esac` pops the innermost open case regardless of position (the
 * reference scanner emits the esac token even in argument position).
 *
 * Heredoc-aware: a `<<` / `<<-` operator queues its delimiter word, and the
 * body lines of every pending heredoc are skipped wholesale right after
 * the next newline — quotes, parens and substitutions inside a heredoc
 * body must not affect the paren count. `((` opens an arithmetic region,
 * skipped as one balanced unit so a left-shift `<<` is not mistaken for a
 * heredoc operator. Comments (`#` at the start of a word, judged by the
 * preceding character after looking through `\`+newline continuations)
 * are skipped to end of line, `${ ... }` / `$[ ... ]` expansions,
 * word-glued `[ ... ]` subscripts, and `[[ ... ]]` conditional regions
 * are skipped as balanced units, so a `<<` inside any of these
 * non-redirection contexts is likewise not mistaken for a heredoc
 * operator.
 */
export function scanBalancedStatements(
  source: string,
  budget: ParseBudget,
  i: number,
  end: number,
  depth = 0,
): BalancedScan {
  if (depth >= MAX_SCAN_DEPTH) return { end, balanced: false };
  let nesting = 0;
  /** Paren depths at which each open case_statement started. */
  const caseDepths: number[] = [];
  /** Heredoc delimiters queued since the last newline. */
  const pendingHeredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let j = i;
  /** What preceded the current position: 'start' | 'sep' | 'keyword' | 'word'. */
  let previous: 'start' | 'sep' | 'keyword' | 'word' = 'start';
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
    if (ch === '"') {
      j = skipDoubleQuoted(source, budget, j, end, depth + 1);
      previous = 'word';
      continue;
    }
    if (ch === "'") {
      j = skipSingleQuoted(source, budget, j, end);
      previous = 'word';
      continue;
    }
    if (ch === '`') {
      j = skipBacktick(source, budget, j, end);
      previous = 'word';
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      j++;
      continue;
    }
    if (ch === '\n') {
      j++;
      if (pendingHeredocs.length > 0) {
        j = skipHeredocBodies(source, budget, j, end, pendingHeredocs);
        pendingHeredocs.length = 0;
      }
      previous = 'sep';
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|') {
      previous = 'sep';
      j++;
      continue;
    }
    if (ch === '{') {
      previous = 'sep';
      j++;
      continue;
    }
    if (ch === '#') {
      let p = j - 1;
      while (p - 1 >= i && source[p] === '\n' && source[p - 1] === '\\') p -= 2;
      const prev = p >= i ? source[p] : undefined;
      if (prev === undefined || isBlank(prev) || prev === '\n' || prev === ';' || prev === '&' || prev === '|' || prev === '(') {
        while (j < end && source[j] !== '\n') j++;
        continue;
      }
    }
    if (ch === '$' && (source[j + 1] === '{' || source[j + 1] === '[')) {
      const open = source[j + 1]!;
      j = scanBalanced(source, budget, j + 1, end, open, open === '{' ? '}' : ']', depth + 1).end;
      previous = 'word';
      continue;
    }
    if (ch === '[' && source[j + 1] === '[' && previous !== 'word') {
      j = scanBalanced(source, budget, j, end, '[', ']', depth + 1).end;
      previous = 'word';
      continue;
    }
    if (ch === '[' && j > i && isWordChar(source[j - 1])) {
      j = scanBalanced(source, budget, j, end, '[', ']', depth + 1).end;
      previous = 'word';
      continue;
    }
    if (ch === '<') {
      const heredoc = scanHeredocDelimiter(source, budget, j, end, depth);
      if (heredoc !== null) {
        pendingHeredocs.push(heredoc);
        j = heredoc.end;
      } else {
        j++;
      }
      previous = 'word';
      continue;
    }
    if (ch === '(') {
      if (source[j + 1] === '(') {
        const arith = scanBalanced(source, budget, j, end, '(', ')', depth + 1);
        if (j === i) return { end: arith.end, balanced: arith.balanced };
        j = arith.end;
        previous = 'word';
        continue;
      }
      nesting++;
      previous = 'sep';
      j++;
      continue;
    }
    if (ch === ')') {
      if (caseDepths.length > 0 && caseDepths.at(-1) === nesting) {
        // A case_item pattern close: not a paren.
        previous = 'sep';
        j++;
        continue;
      }
      nesting--;
      if (nesting === 0) return { end: j + 1, balanced: true };
      previous = 'word';
      j++;
      continue;
    }
    // A word run: check for the case/esac keywords.
    let k = j;
    while (k < end && isWordChar(source[k])) k++;
    if (k > j) {
      const word = source.slice(j, k);
      if (word === 'esac' && caseDepths.length > 0) {
        caseDepths.pop();
        previous = 'sep';
      } else if (word === 'case' && previous !== 'word') {
        caseDepths.push(nesting);
        previous = 'word';
      } else {
        previous = CASE_ENABLING_WORDS.has(word) ? 'keyword' : 'word';
      }
      j = k;
      continue;
    }
    previous = 'word';
    j++;
  }
  return { end, balanced: false };
}

/** Parse a heredoc operator (`<<` / `<<-`) and its delimiter word, starting
 *  at `i` (which points at the first `<`). Returns the delimiter with quotes
 *  and backslashes removed (mirroring the parser's extractHeredocSpec),
 *  whether `<<-` strips leading tabs, and the index just past the delimiter
 *  word — or null when this `<` does not open a heredoc with a non-empty
 *  delimiter (`<<<` herestring, another redirect, or malformed input).
 *  Substitution syntax inside the delimiter word (`$( )`, `${ }`, `$[ ]`,
 *  backticks) is scanned wholesale as part of the word. */
function scanHeredocDelimiter(
  source: string,
  budget: ParseBudget,
  i: number,
  end: number,
  depth: number,
): { delimiter: string; stripTabs: boolean; end: number } | null {
  if (source[i + 1] !== '<') return null;
  let j = i + 2;
  if (source[j] === '<') return null;
  let stripTabs = false;
  if (source[j] === '-') {
    stripTabs = true;
    j++;
  }
  while (j < end && (source[j] === ' ' || source[j] === '\t' || source[j] === '\r')) j++;
  let raw = '';
  while (j < end) {
    const ch = source[j]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break;
    if (ch === '&' || ch === '|' || ch === ';' || ch === '(' || ch === ')' || ch === '<' || ch === '>') break;
    if (ch === '$' && (source[j + 1] === '(' || source[j + 1] === '{' || source[j + 1] === '[')) {
      const open = source[j + 1]!;
      const region =
        open === '('
          ? scanBalancedStatements(source, budget, j + 1, end, depth + 1)
          : scanBalanced(source, budget, j + 1, end, open, open === '{' ? '}' : ']', depth + 1);
      if (!region.balanced) return null;
      raw += source.slice(j, region.end);
      j = region.end;
      continue;
    }
    if (ch === '`') {
      const backtickEnd = skipBacktick(source, budget, j, end);
      if (backtickEnd >= end) return null;
      raw += source.slice(j, backtickEnd);
      j = backtickEnd;
      continue;
    }
    if (ch === '\\') {
      if (j + 1 >= end || source[j + 1] === '\n') return null;
      raw += ch + source[j + 1];
      j += 2;
      continue;
    }
    if (ch === "'") {
      const close = source.indexOf("'", j + 1);
      if (close === -1 || close >= end) return null;
      raw += source.slice(j, close + 1);
      j = close + 1;
      continue;
    }
    if (ch === '"') {
      let k = j + 1;
      for (;;) {
        if (k >= end) return null;
        if (source[k] === '\\') {
          k += 2;
          continue;
        }
        if (source[k] === '"') break;
        k++;
      }
      raw += source.slice(j, k + 1);
      j = k + 1;
      continue;
    }
    raw += ch;
    j++;
  }
  let delimiter = '';
  for (let k = 0; k < raw.length; k++) {
    const ch = raw[k]!;
    if (ch === '\\' && k + 1 < raw.length) {
      delimiter += raw[k + 1];
      k++;
    } else if (ch !== '"' && ch !== "'") {
      delimiter += ch;
    }
  }
  if (delimiter.length === 0) return null;
  return { delimiter, stripTabs, end: j };
}

/** Skip the body lines of each queued heredoc, starting at `i` (just past
 *  the newline that ended the command line). Bodies are consumed in queue
 *  order, each up to its delimiter line (`<<-` allows leading tabs before
 *  the marker), mirroring readHeredocBody; a delimiter directly followed
 *  by `)` also closes the body — the paren belongs to the enclosing
 *  substitution and is left for the paren scan. A body whose delimiter
 *  never appears swallows the rest of the range. */
function skipHeredocBodies(
  source: string,
  budget: ParseBudget,
  i: number,
  end: number,
  specs: readonly { delimiter: string; stripTabs: boolean }[],
): number {
  let j = i;
  for (const spec of specs) {
    let lineStart = j;
    let closed = false;
    while (lineStart < end) {
      budget.progress();
      let marker = lineStart;
      if (spec.stripTabs) {
        while (marker < end && source[marker] === '\t') marker++;
      }
      if (source.startsWith(spec.delimiter, marker)) {
        const after = marker + spec.delimiter.length;
        if (after >= end) {
          j = end;
          closed = true;
          break;
        }
        if (source[after] === '\n') {
          j = after + 1;
          closed = true;
          break;
        }
        if (source[after] === ')') {
          j = after;
          closed = true;
          break;
        }
      }
      const newline = source.indexOf('\n', lineStart);
      if (newline === -1 || newline >= end) break;
      lineStart = newline + 1;
    }
    if (!closed) return end;
  }
  return j;
}

/** Skip a $-construct starting at `i` (which points at the `$`). Handles
 *  $(...), $((...)), ${...}, $'...' (escape-aware: \' does not close),
 *  $name and the single-character specials. A `$` followed by anything else
 *  (including a double quote) consumes just the `$`. */
export function skipDollar(source: string, budget: ParseBudget, i: number, end: number): number {
  const next = source[i + 1];
  if (next === '(') return scanBalancedStatements(source, budget, i + 1, end).end;
  if (next === '{') return scanBalanced(source, budget, i + 1, end, '{', '}').end;
  // $[...] legacy arithmetic (only when `[` directly follows the `$`; `$a[0]`
  // takes the word-character branch above).
  if (next === '[') return scanBalanced(source, budget, i + 1, end, '[', ']').end;
  if (next === "'") {
    // ANSI-C string: \' is an escaped quote and does not terminate it.
    let j = i + 2;
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
      if (ch === "'") return j + 1;
      j++;
    }
    return end;
  }
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
  private lookahead: Token[] = [];
  private readonly pendingHeredocs: HeredocSpec[] = [];

  constructor(
    private readonly source: string,
    private readonly budget: ParseBudget,
    start = 0,
    private readonly end = source.length,
  ) {
    this.pos = start;
  }

  /** End of the lexer's range (exclusive). */
  get rangeEnd(): number {
    return this.end;
  }

  /** Queue a heredoc body to be scanned after the current line. */
  queueHeredoc(spec: HeredocSpec): void {
    this.pendingHeredocs.push(spec);
  }

  peek(): Token {
    return this.peekAt(0);
  }

  /** Look `n` tokens ahead (0 = the next token). Tokens are scanned
   *  on demand and buffered, so lookahead never re-scans. */
  peekAt(n: number): Token {
    while (this.lookahead.length <= n) this.lookahead.push(this.scanToken());
    return this.lookahead[n]!;
  }

  next(): Token {
    if (this.lookahead.length > 0) return this.lookahead.shift()!;
    return this.scanToken();
  }

  /** Rewind the stream to `pos`, discarding buffered lookahead. Used when
   *  the parser consumed a region character-wise (test commands). */
  reposition(pos: number): void {
    this.pos = pos;
    this.lookahead = [];
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
      // `((` at token start opens arithmetic (an arithmetic command or a
      // c-style for header), which is word material, not two parens.
      if (ch === '(' && this.source[this.pos + 1] === '(') return this.scanWord();
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
    // `((...))` at token start: one word token ending right after the
    // balanced close (the parser re-scans the range as arithmetic).
    if (this.source[start] === '(' && this.source[start + 1] === '(') {
      this.pos = scanBalanced(this.source, this.budget, start, this.end, '(', ')').end;
      return { type: 'word', start, end: this.pos, heredocBodies: [] };
    }
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
          i = scanBalancedStatements(this.source, this.budget, i + 1, this.end).end;
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

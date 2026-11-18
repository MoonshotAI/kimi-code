import type { ParseBudget } from '#/budget';
import { SPECIAL_VARIABLE_CHARS } from '#/grammar';

export type TokenType = 'word' | 'op' | 'io_number' | 'newline' | 'comment' | 'eof';

export interface Token {
  readonly type: TokenType;
  readonly start: number;
  readonly end: number;
  readonly heredocBodies: HeredocBody[];
}

export interface HeredocSpec {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  readonly quoted: boolean;
}

export interface HeredocBody {
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly endStart: number;
  readonly endEnd: number;
  readonly found: boolean;
}

const SCAN_TICK_INTERVAL = 2048;

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

export function skipSingleQuoted(source: string, _budget: ParseBudget, i: number, end: number): number {
  const close = source.indexOf("'", i + 1);
  if (close === -1 || close >= end) return end;
  return close + 1;
}

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

export interface BalancedScan {
  end: number;
  balanced: boolean;
}

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

const CASE_ENABLING_WORDS: ReadonlySet<string> = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do']);

export function scanBalancedStatements(
  source: string,
  budget: ParseBudget,
  i: number,
  end: number,
  depth = 0,
): BalancedScan {
  if (depth >= MAX_SCAN_DEPTH) return { end, balanced: false };
  let nesting = 0;
  const caseDepths: number[] = [];
  const pendingHeredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let j = i;
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

export function skipDollar(source: string, budget: ParseBudget, i: number, end: number): number {
  const next = source[i + 1];
  if (next === '(') return scanBalancedStatements(source, budget, i + 1, end).end;
  if (next === '{') return scanBalanced(source, budget, i + 1, end, '{', '}').end;
  if (next === '[') return scanBalanced(source, budget, i + 1, end, '[', ']').end;
  if (next === "'") {
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

  get rangeEnd(): number {
    return this.end;
  }

  queueHeredoc(spec: HeredocSpec): void {
    this.pendingHeredocs.push(spec);
  }

  peek(): Token {
    return this.peekAt(0);
  }

  peekAt(n: number): Token {
    while (this.lookahead.length <= n) this.lookahead.push(this.scanToken());
    return this.lookahead[n]!;
  }

  next(): Token {
    if (this.lookahead.length > 0) return this.lookahead.shift()!;
    return this.scanToken();
  }

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
      if (this.source[this.pos + 1] === '(') return this.scanWord();
      return this.scanOp(REDIRECT_OPERATORS);
    }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '(' || ch === ')') {
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
    this.pos++;
    return { type: 'op', start, end: this.pos, heredocBodies: [] };
  }

  private scanWord(): Token {
    const start = this.pos;
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
    if (i === start) i++;
    this.pos = i;
    return { type: 'word', start, end: i, heredocBodies: [] };
  }

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
    this.pos = this.end;
    return { bodyStart, bodyEnd: this.end, endStart: this.end, endEnd: this.end, found: false };
  }
}

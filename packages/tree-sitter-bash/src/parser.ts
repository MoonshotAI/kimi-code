// src/parser.ts
//
// Recursive-descent bash parser. One method per tree-sitter-bash grammar
// rule (parseList ↔ list, parsePipeline ↔ pipeline, parseCommand ↔ command,
// …), producing node ranges and child layouts that match the real
// tree-sitter-bash 0.25.0 tree.
//
// Construction strategy: the parser builds lightweight `Frame`s, not
// SyntaxNodeBuilders, because heredoc bodies are scanned only when the line
// ends — a heredoc_redirect node (and every ancestor) gets its final range
// after the fact. Frames are mutable and carry parent pointers so the
// heredoc drain can extend the ancestor chain. `materialize` converts the
// finished frame tree into SyntaxNodeBuilders iteratively (explicit stack,
// safe for pathologically deep trees) once parsing is done.
//
// Error recovery: unterminated constructs (quote, expansion, substitution,
// heredoc, compound commands) keep their partial node and set hasError;
// tokens that cannot start or continue a statement are wrapped in an ERROR
// node and parsing continues. No parser-internal exception is expected to
// escape; parse() still guards against it.
//
// Depth guards, all capped so pathological nesting degrades locally
// (ERROR nodes, hasError) instead of overflowing the call stack:
//   - word-level substitutions ($( … ) / `…` / <( … )) recurse via fresh
//     sub-Parser instances bounded to their source range — the deepest
//     chain per level (~13 frames), capped by MAX_SUBSTITUTION_DEPTH;
//   - subshells and compound commands (if/while/for/case/{…}/function
//     bodies) recurse within one parser (`scopeDepth`);
//   - the parseLiteral ↔ parseString ↔ parseExpansion chain behind ${ … }
//     nesting — including the pattern → string → $ cycle — has its own
//     counter (`literalDepth`, incremented by both parseLiteral and
//     parseExpansion);
//   - parenthesized_expression nesting inside arithmetic/test expressions
//     uses `exprDepth`.
// The last three are capped by MAX_PARSE_DEPTH; beyond the caps the
// construct degrades (compound keywords fall back to plain commands,
// expressions and substitutions to ERROR nodes). The lexer's own scan
// recursion (scanBalanced ↔ skipDoubleQuoted) is cheaper per level and
// capped separately (MAX_SCAN_DEPTH in lexer.ts).
//
// Expression engine: arithmetic expansions ($((…)), ((…)), $[…]), c-style
// for headers and test commands ([[ … ]] / [ … ]) share a small Pratt
// parser (parseExpression over an ExprState) driven by the precedence table
// in grammar.ts, mirroring grammar.js's PREC levels and the tree shapes they
// produce (e.g. prefix -/+/~/! grab a full tighter-precedence expression:
// $((-x + ~y)) is unary(-, binary(x, +, unary(~, y))) in the reference).

import type { ParseBudget } from '#/budget';
import {
  DECLARATION_COMMAND_KEYWORDS,
  EXPRESSION_OPERATORS,
  EXPRESSION_PRECEDENCE,
  FILE_REDIRECT_OPERATORS,
  RESERVED_WORDS,
  SPECIAL_VARIABLE_CHARS,
  UNSET_COMMAND_KEYWORDS,
} from '#/grammar';
import { Lexer, scanBalanced, scanBalancedStatements, skipBacktick, skipDoubleQuoted, skipSingleQuoted } from '#/lexer';
import type { BalancedScan, HeredocBody, HeredocSpec, Token } from '#/lexer';
import { SyntaxNodeBuilder } from '#/node';

/** Maximum nesting of scopes (subshells, compound commands, expressions,
 *  ${…} chains). These chains cost only a handful of stack frames per
 *  level and their guards skip iteratively, so 500 is comfortably safe —
 *  verified: inputs thousands of levels deep degrade locally instead of
 *  overflowing. */
export const MAX_PARSE_DEPTH = 500;

/**
 * Maximum nesting of the $( … ) / `…` / <( … ) sub-parser chain (each
 * level spawns a fresh Parser and costs ~13 stack frames through
 * parseCommandSubstitution → parseScopedStatements → parseStatementList →
 * parseCommand → parseLiteral → parseDollar). Measured overflow on a
 * default Node stack: ~380–500 levels depending on environment, BEFORE the
 * old 500 cap could fire. 150 keeps a ≥2.5× margin; beyond it the
 * substitution degrades to a local ERROR node (hasError) instead of
 * taking the whole tree down via a RangeError.
 */
export const MAX_SUBSTITUTION_DEPTH = 150;

const FILE_REDIRECT_OP_SET: ReadonlySet<string> = new Set(FILE_REDIRECT_OPERATORS);
const DECLARATION_COMMAND_SET: ReadonlySet<string> = new Set(DECLARATION_COMMAND_KEYWORDS);
const UNSET_COMMAND_SET: ReadonlySet<string> = new Set(UNSET_COMMAND_KEYWORDS);
const RESERVED_WORD_SET: ReadonlySet<string> = new Set(RESERVED_WORDS);
const NUMBER_RE = /^-?(0x)?[0-9]+(#[0-9A-Za-z@_]+)?$/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const ASSIGNMENT_SPLIT_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/;
const SUBSCRIPT_ASSIGNMENT_RE = /^(\w+)\[([^\]\n]*)\](\+?=)/;
const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;
const BRACE_EXPRESSION_RE = /^\{(\d+)\.\.(\d+)\}/;
/** Statement-position `((…))` that tree-sitter-bash parses as a
 *  test_command: inner text starting with an identifier-ish token
 *  (letters/digits/`_`/`-`) ending in `++`/`--`. */
const PAREN_TEST_RE = /^\(\(\s*[A-Za-z_][\w-]*(\+\+|--)/;
const STOP_THEN: ReadonlySet<string> = new Set(['then']);
const STOP_DO: ReadonlySet<string> = new Set(['do']);
const STOP_DONE: ReadonlySet<string> = new Set(['done']);
const STOP_IF_BODY: ReadonlySet<string> = new Set(['elif', 'else', 'fi']);
const STOP_FI: ReadonlySet<string> = new Set(['fi']);
const STOP_CLOSE_BRACE: ReadonlySet<string> = new Set(['}']);
const STOP_ESAC: ReadonlySet<string> = new Set(['esac']);
const CASE_TERMINATION_OPS: ReadonlySet<string> = new Set([';;', ';&', ';;&']);

/** How often long scan loops tick the budget, in scanned characters. */
const SCAN_TICK_INTERVAL = 2048;

// Precedence levels from grammar.js's PREC table that are not in
// EXPRESSION_PRECEDENCE.
const PREC_TERNARY = 2;
const PREC_TEST = 10;
const PREC_UNARY = 11;
const PREC_PREFIX = 17;
const PREC_POSTFIX = 18;

/** Mutable node under construction; see the file header. */
export interface Frame {
  type: string;
  start: number;
  end: number;
  isNamed: boolean;
  parent: Frame | null;
  children: Frame[];
}

interface PendingHeredoc {
  frame: Frame;
  spec: HeredocSpec;
}

interface StatementListOptions {
  readonly stopAtParen?: boolean;
  readonly stopWords?: ReadonlySet<string>;
  readonly stopOps?: ReadonlySet<string>;
  /** True when the grammar requires a terminator before the stop keyword
   *  (if/while/do bodies, `{ … }`): stopping with a pending statement and
   *  no separator flags an error (`if a; then b fi` is an error in the
   *  reference too). Case items and subshells do not require one. */
  readonly terminatorRequired?: boolean;
}

/** Where the expression engine runs: arithmetic expansions, c-style for
 *  headers, or test commands. */
type ExprMode = 'arith' | 'c' | 'test';

type ExprTokenKind =
  | 'number'
  | 'ident'
  | 'word'
  | 'subst'
  | 'string'
  | 'testop'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'unknown'
  | 'end';

interface ExprToken {
  readonly kind: ExprTokenKind;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Pre-built node for subst/string/subscript tokens. */
  readonly frame?: Frame;
}

interface ExprState {
  pos: number;
  readonly end: number;
  readonly mode: ExprMode;
  lookahead: ExprToken | null;
  /** Nesting of parenthesized_expression inside test commands (the
   *  reference emits word, not extglob_pattern, for a non-glob ==/!=
   *  right-hand side inside parentheses). */
  parenDepth: number;
  /** Test mode only: true after a complete operand, where `=`/`!`-family
   *  characters are comparison operators even when attached to the next
   *  word (`a ==b` is `a == b`); false at operand position, where they are
   *  word characters (`=b`, `!x`, `a!=b` are words in the reference). */
  expectOperator: boolean;
}

function isFileRedirectOp(text: string): boolean {
  return FILE_REDIRECT_OP_SET.has(text);
}

/** Strip quoting from a heredoc delimiter word; any quote or backslash in
 *  the raw text marks the body as quoted (no expansions). */
function extractHeredocSpec(raw: string, stripTabs: boolean): HeredocSpec {
  let delimiter = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '\\' && i + 1 < raw.length) {
      delimiter += raw[i + 1];
      quoted = true;
      i++;
    } else if (ch === '"' || ch === "'") {
      quoted = true;
    } else {
      delimiter += ch;
    }
  }
  return { delimiter, stripTabs, quoted };
}

export class Parser {
  /** Set when any recovery path was taken. */
  hasError = false;
  private lexer!: Lexer;
  private readonly heredocQueue: PendingHeredoc[] = [];
  private scopeDepth = 0;
  /** Recursion depth of parseLiteral ↔ parseString / parseExpansion (the
   *  ${} nesting chain that stays inside this Parser instance). */
  private literalDepth = 0;
  /** Nesting of parenthesized_expression inside the expression parser. */
  private exprDepth = 0;
  /** True while parsing inside a heredoc's line tail: a second heredoc
   *  cannot be represented and degrades to ERROR (see parseHeredocRedirect). */
  private noHeredoc = false;
  /** Nesting of case_item statement lists (see parseCaseItemStatements). */
  private caseItemDepth = 0;
  /** End of the most recently consumed `;`/`&`/`;;`/newline terminator in
   *  any statement list. case_item uses it to extend its range over a
   *  trailing terminator before `esac`, matching the reference (whose
   *  last_case_item includes the final _terminator in its range). */
  private lastTerminatorEnd = 0;

  constructor(
    private readonly source: string,
    private readonly budget: ParseBudget,
    private readonly depth = 0,
  ) {}

  // ---------------------------------------------------------------- helpers

  private frame(type: string, start: number, end: number, children: Frame[] = [], isNamed = true): Frame {
    this.budget.tick();
    const frame: Frame = { type, start, end, isNamed, parent: null, children };
    for (const child of children) child.parent = frame;
    return frame;
  }

  private anon(type: string, start: number, end: number): Frame {
    return this.frame(type, start, end, [], false);
  }

  private addKid(parent: Frame, child: Frame): void {
    child.parent = parent;
    parent.children.push(child);
  }

  private text(start: number, end: number): string {
    return this.source.slice(start, end);
  }

  private tokenText(token: Token): string {
    return this.source.slice(token.start, token.end);
  }

  private endOf(kids: Frame[], fallback: number): number {
    return kids.length > 0 ? kids.at(-1)!.end : fallback;
  }

  private isStatementStart(token: Token): boolean {
    if (token.type === 'word' || token.type === 'io_number') return true;
    if (token.type !== 'op') return false;
    const text = this.tokenText(token);
    return text === '(' || text === '<<<' || text === '<<' || text === '<<-' || isFileRedirectOp(text);
  }

  /** Peeked word token whose text equals `keyword`. */
  private peekKeyword(keyword: string): boolean {
    const token = this.lexer.peek();
    return token.type === 'word' && this.tokenText(token) === keyword;
  }

  /** Consume a keyword as an anonymous child; false (no consume) when the
   *  next token is not that keyword. */
  private consumeKeyword(kids: Frame[], keyword: string): boolean {
    if (!this.peekKeyword(keyword)) return false;
    const token = this.lexer.next();
    kids.push(this.anon(keyword, token.start, token.end));
    return true;
  }

  // ------------------------------------------------------------ entry point

  /** program: the whole source as one statement list. */
  parseProgram(): Frame {
    this.lexer = new Lexer(this.source, this.budget, 0, this.source.length);
    const children = this.parseStatementList();
    return this.frame('program', 0, this.source.length, children);
  }

  /** Parse a sub-range as a statement list (body of $( … ), ` … `, <( … )).
   *  The sub-parser chain is the deepest per-level recursion in the
   *  parser, so it has its own, tighter cap — see MAX_SUBSTITUTION_DEPTH. */
  private parseScopedStatements(start: number, end: number): Frame[] {
    if (this.depth + 1 >= MAX_SUBSTITUTION_DEPTH) {
      this.hasError = true;
      return [this.frame('ERROR', start, end)];
    }
    const sub = new Parser(this.source, this.budget, this.depth + 1);
    sub.lexer = new Lexer(this.source, this.budget, start, end);
    const children = sub.parseStatementList();
    if (sub.hasError) this.hasError = true;
    return children;
  }

  // -------------------------------------------------------- statement lists

  /**
   * _statements: statements separated/terminated by ; & and newlines.
   * `;`/`&`/`;;` terminators become anonymous children; newlines and
   * comments do not (comments stay named children) — tree-sitter-bash never
   * emits `\n` terminator nodes either. Parsing stops (without consuming)
   * at a word in stopWords (then/do/done/fi/esac/…), an op in stopOps
   * (case_item terminators), or a `)` when stopAtParen is set.
   */
  private parseStatementList(options: StatementListOptions = {}): Frame[] {
    const children: Frame[] = [];
    let needTerminator = false;
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'eof') {
        this.completeHeredocs(token.heredocBodies);
        this.failOpenHeredocs();
        break;
      }
      if (token.type === 'newline') {
        this.lexer.next();
        this.completeHeredocs(token.heredocBodies);
        this.lastTerminatorEnd = token.end;
        needTerminator = false;
        continue;
      }
      if (token.type === 'comment') {
        this.lexer.next();
        children.push(this.frame('comment', token.start, token.end));
        continue;
      }
      if (token.type === 'word' && options.stopWords?.has(this.tokenText(token)) === true) {
        if (needTerminator && options.terminatorRequired === true) this.hasError = true; // missing separator
        break;
      }
      const op = token.type === 'op' ? this.tokenText(token) : '';
      if (token.type === 'op' && options.stopOps?.has(op) === true) break;
      if (token.type === 'op' && op === ')' && options.stopAtParen === true) {
        this.failOpenHeredocs();
        break;
      }
      if (token.type === 'op' && (op === ';' || op === '&' || op === ';;')) {
        this.lexer.next();
        children.push(this.anon(op, token.start, token.end));
        this.lastTerminatorEnd = token.end;
        needTerminator = false;
        continue;
      }
      if (
        token.type === 'op' &&
        (op === ')' || op === '&&' || op === '||' || op === '|' || op === '|&' || op === ';&' || op === ';;&')
      ) {
        // A binary operator or closer with no left-hand side: recover.
        this.hasError = true;
        this.lexer.next();
        children.push(this.frame('ERROR', token.start, token.end, [this.anon(op, token.start, token.end)]));
        needTerminator = false;
        continue;
      }
      if (needTerminator) this.hasError = true; // missing separator, e.g. `cmd (sub)`
      children.push(this.parseList());
      needTerminator = true;
    }
    return children;
  }

  /** Consume newlines and comments in operator-continuation position
   *  (`a &&\n b`). Returns the comment nodes; newlines are dropped. */
  private skipContinuation(): Frame[] {
    const comments: Frame[] = [];
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'newline') {
        this.lexer.next();
        this.completeHeredocs(token.heredocBodies);
        continue;
      }
      if (token.type === 'comment') {
        this.lexer.next();
        comments.push(this.frame('comment', token.start, token.end));
        continue;
      }
      return comments;
    }
  }

  // ------------------------------------------------------------- statements

  /** list: statement ((&& | ||) statement)* — left associative. */
  private parseList(): Frame {
    let left = this.parsePipeline();
    for (;;) {
      const token = this.lexer.peek();
      if (token.type !== 'op') break;
      const op = this.tokenText(token);
      if (op !== '&&' && op !== '||') break;
      this.lexer.next();
      const extras = this.skipContinuation();
      if (this.isStatementStart(this.lexer.peek())) {
        const right = this.parsePipeline();
        left = this.frame('list', left.start, right.end, [left, this.anon(op, token.start, token.end), ...extras, right]);
      } else {
        // Trailing connector (`ls &&`): keep the partial list, flag it.
        this.hasError = true;
        left = this.frame('list', left.start, token.end, [left, this.anon(op, token.start, token.end)]);
        break;
      }
    }
    return left;
  }

  /** pipeline: statement ((&#124; | &#124;&) statement)* */
  private parsePipeline(): Frame {
    return this.parsePipelineTail(this.parseStatementNotPipeline());
  }

  private parsePipelineTail(first: Frame): Frame {
    const kids: Frame[] = [first];
    let end = first.end;
    let pipes = 0;
    for (;;) {
      const token = this.lexer.peek();
      if (token.type !== 'op') break;
      const op = this.tokenText(token);
      if (op !== '|' && op !== '|&') break;
      this.lexer.next();
      pipes++;
      kids.push(this.anon(op, token.start, token.end));
      end = token.end;
      kids.push(...this.skipContinuation());
      if (this.isStatementStart(this.lexer.peek())) {
        const next = this.parseStatementNotPipeline();
        kids.push(next);
        end = next.end;
      } else {
        this.hasError = true; // dangling pipe (`ls |`)
        break;
      }
    }
    if (pipes === 0) return first;
    return this.frame('pipeline', first.start, end, kids);
  }

  /** _statement_not_pipeline: any statement form plus trailing redirects. */
  private parseStatementNotPipeline(): Frame {
    let inner: Frame | null = this.parseStatementCore();
    const trailing: Frame[] = [];
    for (;;) {
      const next = this.lexer.peek();
      if (next.type === 'io_number') {
        trailing.push(this.parseRedirect());
        continue;
      }
      if (next.type === 'op') {
        const op = this.tokenText(next);
        if (isFileRedirectOp(op) || op === '<<<' || op === '<<' || op === '<<-') {
          trailing.push(this.parseRedirect());
          continue;
        }
      }
      break;
    }
    if (trailing.length > 0) {
      const kids = inner === null ? trailing : [inner, ...trailing];
      inner = this.frame('redirected_statement', kids[0]!.start, kids.at(-1)!.end, kids);
    }
    if (inner === null) {
      // Unreachable from well-formed dispatch; recover without looping.
      this.hasError = true;
      const skipped = this.lexer.next();
      inner = this.frame('ERROR', skipped.start, skipped.end);
    }
    return inner;
  }

  /**
   * Dispatch one statement (no pipeline, no trailing redirects) on its
   * leading token: subshell, negation, compound commands, test commands,
   * declaration/unset commands, function definitions, or a plain command.
   * Reserved words only count at statement position — `echo if` keeps `if`
   * as a word, and a prefix assignment (`x=1 if …`) disables the keyword
   * reading just like in the reference.
   */
  private parseStatementCore(): Frame | null {
    const token = this.lexer.peek();
    if (token.type === 'op' && this.tokenText(token) === '(') {
      return this.parseSubshell();
    }
    if (token.type === 'word') {
      const text = this.tokenText(token);
      if (text === '!') return this.parseNegatedCommand();
      if (text === '{') {
        // `{1..3}` at statement position is a brace_expression word.
        if (!BRACE_EXPRESSION_RE.test(this.source.slice(token.start))) {
          return this.parseCompoundGuarded(() => this.parseCompoundStatement());
        }
      } else if (text === 'if') {
        return this.parseCompoundGuarded(() => this.parseIfStatement());
      } else if (text === 'while' || text === 'until') {
        return this.parseCompoundGuarded(() => this.parseWhileStatement());
      } else if (text === 'for' || text === 'select') {
        return this.parseCompoundGuarded(() => this.parseForStatement());
      } else if (text === 'case') {
        return this.parseCompoundGuarded(() => this.parseCaseStatement());
      } else if (text === 'function') {
        return this.parseCompoundGuarded(() => this.parseFunctionDefinition());
      } else if (text === '[') {
        return this.parseTestCommand();
      } else if (text.startsWith('((') && PAREN_TEST_RE.test(text)) {
        // `((word++…))` / `((word--…))` at statement position is a
        // test_command in the reference (its statement-position arithmetic
        // grammar does not accept a leading postfix operand), while other
        // `((…))` forms are arithmetic_expansion command names.
        return this.parseParenTestCommand();
      } else if (DECLARATION_COMMAND_SET.has(text)) {
        return this.parseDeclarationCommand();
      } else if (UNSET_COMMAND_SET.has(text)) {
        return this.parseUnsetCommand();
      } else if (this.isFunctionDefinitionAhead()) {
        return this.parseCompoundGuarded(() => this.parseFunctionDefinition());
      }
    }
    return this.parseCommand();
  }

  /**
   * Run a compound-statement parser under the scope-depth guard: beyond
   * MAX_PARSE_DEPTH the keyword is parsed as a plain command word instead,
   * which bounds the recursion chain (if → statements → if → …).
   */
  private parseCompoundGuarded(parse: () => Frame): Frame {
    if (this.scopeDepth >= MAX_PARSE_DEPTH) {
      this.hasError = true;
      const fallback = this.parseCommand();
      if (fallback !== null) return fallback;
      const token = this.lexer.next();
      return this.frame('ERROR', token.start, token.end);
    }
    this.scopeDepth++;
    try {
      return parse();
    } finally {
      this.scopeDepth--;
    }
  }

  /** negated_command: `!` followed by a command, test command, assignment
   *  or subshell (the grammar's full choice). */
  private parseNegatedCommand(): Frame {
    const bang = this.lexer.next();
    const kids: Frame[] = [this.anon('!', bang.start, bang.end)];
    let end = bang.end;
    const token = this.lexer.peek();
    if (token.type === 'op' && this.tokenText(token) === '(') {
      const subshell = this.parseSubshell();
      kids.push(subshell);
      end = subshell.end;
    } else if (token.type === 'word' && this.tokenText(token) === '[') {
      const test = this.parseTestCommand();
      kids.push(test);
      end = test.end;
    } else if (token.type === 'word' && this.tokenText(token).startsWith('((') && PAREN_TEST_RE.test(this.tokenText(token))) {
      const test = this.parseParenTestCommand();
      kids.push(test);
      end = test.end;
    } else {
      const command = this.parseCommand();
      if (command === null) {
        this.hasError = true;
      } else {
        kids.push(command);
        end = command.end;
      }
    }
    return this.frame('negated_command', bang.start, end, kids);
  }

  /** subshell: `(` _statements `)` */
  private parseSubshell(): Frame {
    const open = this.lexer.next();
    if (this.scopeDepth >= MAX_PARSE_DEPTH) {
      // Absurd nesting: skip token-wise to the matching close paren. Word
      // tokens hide their internal parens, so token-level counting is exact.
      this.hasError = true;
      let depth = 1;
      let end = open.end;
      for (;;) {
        const token = this.lexer.next();
        end = token.end;
        if (token.type === 'eof') break;
        this.completeHeredocs(token.heredocBodies);
        if (token.type === 'op') {
          const op = this.tokenText(token);
          if (op === '(') depth++;
          else if (op === ')') {
            depth--;
            if (depth === 0) break;
          }
        }
      }
      return this.frame('ERROR', open.start, end, [this.anon('(', open.start, open.end)]);
    }
    const kids: Frame[] = [this.anon('(', open.start, open.end)];
    this.scopeDepth++;
    const inner = this.parseStatementList({ stopAtParen: true });
    this.scopeDepth--;
    if (inner.length === 0) this.hasError = true; // empty subshell (grammar requires statements)
    kids.push(...inner);
    let end = this.endOf(inner, open.end);
    const token = this.lexer.peek();
    if (token.type === 'op' && this.tokenText(token) === ')') {
      this.lexer.next();
      kids.push(this.anon(')', token.start, token.end));
      end = token.end;
    } else {
      this.hasError = true; // unterminated subshell
    }
    return this.frame('subshell', open.start, end, kids);
  }

  // ------------------------------------------------------ compound commands

  /** compound_statement: `{` _terminated_statement `}` */
  private parseCompoundStatement(): Frame {
    const open = this.lexer.next();
    const kids: Frame[] = [
      this.anon('{', open.start, open.end),
      ...this.parseStatementList({ stopWords: STOP_CLOSE_BRACE, terminatorRequired: true }),
    ];
    let end = this.endOf(kids, open.end);
    const token = this.lexer.peek();
    if (token.type === 'word' && this.tokenText(token) === '}') {
      this.lexer.next();
      kids.push(this.anon('}', token.start, token.end));
      end = token.end;
    } else {
      this.hasError = true; // unterminated { …
    }
    return this.frame('compound_statement', open.start, end, kids);
  }

  /** if_statement: `if` condition `then` body elif* else? `fi` */
  private parseIfStatement(): Frame {
    const ifToken = this.lexer.next();
    const kids: Frame[] = [
      this.anon('if', ifToken.start, ifToken.end),
      ...this.parseStatementList({ stopWords: STOP_THEN, terminatorRequired: true }),
    ];
    if (!this.consumeKeyword(kids, 'then')) {
      this.hasError = true; // missing then
      return this.frame('if_statement', ifToken.start, this.endOf(kids, ifToken.end), kids);
    }
    kids.push(...this.parseStatementList({ stopWords: STOP_IF_BODY, terminatorRequired: true }));
    while (this.peekKeyword('elif')) {
      kids.push(this.parseElifClause());
    }
    if (this.peekKeyword('else')) {
      kids.push(this.parseElseClause());
    }
    let end = this.endOf(kids, ifToken.end);
    if (this.consumeKeyword(kids, 'fi')) {
      end = kids.at(-1)!.end;
    } else {
      this.hasError = true; // unterminated if
    }
    return this.frame('if_statement', ifToken.start, end, kids);
  }

  /** elif_clause: `elif` condition `then` body */
  private parseElifClause(): Frame {
    const elifToken = this.lexer.next();
    const kids: Frame[] = [
      this.anon('elif', elifToken.start, elifToken.end),
      ...this.parseStatementList({ stopWords: STOP_THEN, terminatorRequired: true }),
    ];
    if (!this.consumeKeyword(kids, 'then')) {
      this.hasError = true;
      return this.frame('elif_clause', elifToken.start, this.endOf(kids, elifToken.end), kids);
    }
    kids.push(...this.parseStatementList({ stopWords: STOP_IF_BODY, terminatorRequired: true }));
    // Like case_item, an elif/else clause extends over its trailing
    // terminator (usually a newline) in the reference.
    const end = Math.max(this.endOf(kids, elifToken.end), this.lastTerminatorEnd);
    return this.frame('elif_clause', elifToken.start, end, kids);
  }

  /** else_clause: `else` body */
  private parseElseClause(): Frame {
    const elseToken = this.lexer.next();
    const kids: Frame[] = [
      this.anon('else', elseToken.start, elseToken.end),
      ...this.parseStatementList({ stopWords: STOP_FI, terminatorRequired: true }),
    ];
    const end = Math.max(this.endOf(kids, elseToken.end), this.lastTerminatorEnd);
    return this.frame('else_clause', elseToken.start, end, kids);
  }

  /** while_statement: (`while` | `until`) condition do_group */
  private parseWhileStatement(): Frame {
    const kwToken = this.lexer.next();
    const keyword = this.tokenText(kwToken);
    const kids: Frame[] = [
      this.anon(keyword, kwToken.start, kwToken.end),
      ...this.parseStatementList({ stopWords: STOP_DO, terminatorRequired: true }),
    ];
    if (this.peekKeyword('do')) {
      kids.push(this.parseDoGroup());
    } else {
      this.hasError = true; // missing do
    }
    return this.frame('while_statement', kwToken.start, this.endOf(kids, kwToken.end), kids);
  }

  /** do_group: `do` body `done` */
  private parseDoGroup(): Frame {
    const doToken = this.lexer.next();
    const kids: Frame[] = [
      this.anon('do', doToken.start, doToken.end),
      ...this.parseStatementList({ stopWords: STOP_DONE, terminatorRequired: true }),
    ];
    let end = this.endOf(kids, doToken.end);
    if (this.consumeKeyword(kids, 'done')) {
      end = kids.at(-1)!.end;
    } else {
      this.hasError = true; // unterminated do
    }
    return this.frame('do_group', doToken.start, end, kids);
  }

  /** Consume the terminator between a for-header and its body: `;`/`&`
   *  become anonymous children, newlines are dropped, comments are kept. */
  private consumeForTerminator(kids: Frame[]): void {
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'newline') {
        this.lexer.next();
        this.completeHeredocs(token.heredocBodies);
        continue;
      }
      if (token.type === 'comment') {
        this.lexer.next();
        kids.push(this.frame('comment', token.start, token.end));
        continue;
      }
      if (token.type === 'op') {
        const op = this.tokenText(token);
        if (op === ';' || op === '&') {
          this.lexer.next();
          kids.push(this.anon(op, token.start, token.end));
        }
      }
      break;
    }
  }

  /** for_statement: (`for` | `select`) variable (`in` values)? terminator
   *  do_group — or, for `for ((…))`, a c_style_for_statement. */
  private parseForStatement(): Frame {
    const kwToken = this.lexer.next();
    const keyword = this.tokenText(kwToken);
    const kids: Frame[] = [this.anon(keyword, kwToken.start, kwToken.end)];
    const next = this.lexer.peek();
    if (keyword === 'for' && next.type === 'word' && this.tokenText(next).startsWith('((')) {
      return this.parseCStyleForStatement(kwToken, kids);
    }
    const varToken = this.lexer.peek();
    if (varToken.type === 'word' && /^\w+$/.test(this.tokenText(varToken))) {
      this.lexer.next();
      kids.push(this.frame('variable_name', varToken.start, varToken.end));
    } else {
      this.hasError = true; // missing loop variable
    }
    if (this.peekKeyword('in')) {
      const inToken = this.lexer.next();
      const values: Frame[] = [];
      while (this.lexer.peek().type === 'word') {
        values.push(this.parseWordArgument());
      }
      if (values.length === 0) {
        // `for x in; do` — the reference wraps the bare `in` in ERROR.
        this.hasError = true;
        kids.push(this.frame('ERROR', inToken.start, inToken.end, [this.anon('in', inToken.start, inToken.end)]));
      } else {
        kids.push(this.anon('in', inToken.start, inToken.end));
        kids.push(...values);
      }
    }
    this.consumeForTerminator(kids);
    if (this.peekKeyword('do')) {
      kids.push(this.parseDoGroup());
    } else {
      this.hasError = true; // missing do
    }
    return this.frame('for_statement', kwToken.start, this.endOf(kids, kwToken.end), kids);
  }

  /** c_style_for_statement: `for` `((` init `;` cond `;` update `))`
   *  terminator (do_group | compound_statement). The whole ((…)) header
   *  arrived as one word token (see the lexer). */
  private parseCStyleForStatement(kwToken: Token, kids: Frame[]): Frame {
    const header = this.lexer.next();
    const closed =
      header.end - header.start >= 4 && this.source[header.end - 2] === ')' && this.source[header.end - 1] === ')';
    if (!closed) this.hasError = true;
    kids.push(this.anon('((', header.start, header.start + 2));
    const innerEnd = closed ? header.end - 2 : header.end;
    kids.push(...this.parseCForBody(header.start + 2, innerEnd));
    if (closed) {
      kids.push(this.anon('))', header.end - 2, header.end));
    }
    this.consumeForTerminator(kids);
    if (this.peekKeyword('do')) {
      kids.push(this.parseDoGroup());
    } else if (this.peekKeyword('{')) {
      kids.push(this.parseCompoundStatement());
    } else {
      this.hasError = true; // missing body
    }
    return this.frame('c_style_for_statement', kwToken.start, this.endOf(kids, kwToken.end), kids);
  }

  /** The init/condition/update parts of a c-style for header: three
   *  comma-separated c-expression lists divided by `;`. */
  private parseCForBody(start: number, end: number): Frame[] {
    const st = this.newExprState(start, end, 'c');
    const kids: Frame[] = [];
    for (let part = 0; part < 3; part++) {
      for (;;) {
        const expression = this.parseExpression(st, 0);
        if (expression !== null) kids.push(expression);
        const token = this.exprPeek(st);
        if (token.kind === 'op' && token.text === ',') {
          this.exprNext(st);
          kids.push(this.anon(',', token.start, token.end));
          continue;
        }
        break;
      }
      if (part < 2) {
        const token = this.exprPeek(st);
        if (token.kind === 'op' && token.text === ';') {
          this.exprNext(st);
          kids.push(this.anon(';', token.start, token.end));
        } else {
          this.hasError = true; // missing ; in for-header
          break;
        }
      }
    }
    const leftover = this.exprLeftover(st);
    if (leftover !== null) kids.push(leftover);
    return kids;
  }

  /** case_statement: `case` value `in` case_item* `esac` */
  private parseCaseStatement(): Frame {
    const caseToken = this.lexer.next();
    const kids: Frame[] = [this.anon('case', caseToken.start, caseToken.end)];
    if (this.lexer.peek().type === 'word') {
      kids.push(this.parseWordArgument());
    } else {
      this.hasError = true; // missing value
    }
    this.skipCaseTerminators(kids);
    if (!this.consumeKeyword(kids, 'in')) {
      this.hasError = true;
      return this.frame('case_statement', caseToken.start, this.endOf(kids, caseToken.end), kids);
    }
    this.skipCaseTerminators(kids);
    for (;;) {
      // Between items: newlines are dropped, comments kept as children.
      for (;;) {
        const token = this.lexer.peek();
        if (token.type === 'newline') {
          this.lexer.next();
          this.completeHeredocs(token.heredocBodies);
          continue;
        }
        if (token.type === 'comment') {
          this.lexer.next();
          kids.push(this.frame('comment', token.start, token.end));
          continue;
        }
        break;
      }
      const token = this.lexer.peek();
      if (token.type === 'eof') {
        this.hasError = true; // missing esac
        break;
      }
      if (token.type === 'word' && this.tokenText(token) === 'esac') break;
      const before = this.lexer.pos;
      kids.push(this.parseCaseItem());
      if (this.lexer.pos === before) {
        // Defensive: a case_item that consumed nothing would loop forever.
        this.hasError = true;
        this.lexer.next();
      }
      if (this.peekKeyword('esac')) {
        // A fallthrough terminator on the LAST item is a grammar error in
        // the reference (last_case_item only allows `;;`).
        const last = kids.at(-1)!.children.at(-1);
        if (last !== undefined && !last.isNamed && (last.type === ';&' || last.type === ';;&')) {
          this.hasError = true;
        }
      }
    }
    let end = this.endOf(kids, caseToken.end);
    if (this.consumeKeyword(kids, 'esac')) {
      end = kids.at(-1)!.end;
    }
    return this.frame('case_statement', caseToken.start, end, kids);
  }

  /** Terminators around `in` / between case items: newlines dropped, `;`/`&`
   *  kept as anonymous children, comments kept. */
  private skipCaseTerminators(kids: Frame[]): void {
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'newline') {
        this.lexer.next();
        this.completeHeredocs(token.heredocBodies);
        continue;
      }
      if (token.type === 'comment') {
        this.lexer.next();
        kids.push(this.frame('comment', token.start, token.end));
        continue;
      }
      if (token.type === 'op') {
        const op = this.tokenText(token);
        if (op === ';' || op === '&') {
          this.lexer.next();
          kids.push(this.anon(op, token.start, token.end));
          continue;
        }
      }
      break;
    }
  }

  /**
   * case_item: `(`? pattern (`|` pattern)* `)` statements? terminator?
   * Patterns are literals, except bare words that contain a glob character
   * (* ? [) or that are followed by `|` — those are extglob_pattern nodes,
   * matching the reference scanner.
   */
  private parseCaseItem(): Frame {
    const kids: Frame[] = [];
    let token = this.lexer.peek();
    if (token.type === 'op' && this.tokenText(token) === '(') {
      this.lexer.next();
      kids.push(this.anon('(', token.start, token.end));
    }
    // Patterns.
    for (;;) {
      token = this.lexer.peek();
      if (token.type !== 'word') {
        this.hasError = true; // missing pattern
        break;
      }
      const [start, end] = this.consumeWordRun();
      const raw = this.text(start, end);
      const bare = !/["'$`\\]/.test(raw);
      const followedByAlternate = this.lexer.peek().type === 'op' && this.tokenText(this.lexer.peek()) === '|';
      if (bare && (/[*?[\]]/.test(raw) || followedByAlternate)) {
        kids.push(this.frame('extglob_pattern', start, end));
      } else {
        kids.push(this.parseLiteral(start, end));
      }
      token = this.lexer.peek();
      if (token.type === 'op' && this.tokenText(token) === '|') {
        this.lexer.next();
        kids.push(this.anon('|', token.start, token.end));
        continue;
      }
      break;
    }
    token = this.lexer.peek();
    if (token.type === 'op' && this.tokenText(token) === ')') {
      this.lexer.next();
      kids.push(this.anon(')', token.start, token.end));
    } else {
      this.hasError = true; // missing )
    }
    kids.push(...this.parseCaseItemStatements());
    token = this.lexer.peek();
    if (token.type === 'op') {
      const op = this.tokenText(token);
      if (op === ';;' || op === ';&' || op === ';;&') {
        this.lexer.next();
        kids.push(this.anon(op, token.start, token.end));
      }
    }
    const start = kids.length > 0 ? kids[0]!.start : token.start;
    // An item closed by `esac` (no `;;`) extends over its trailing
    // terminator (usually a newline) in the reference.
    const end = Math.max(this.endOf(kids, token.start), this.lastTerminatorEnd);
    return this.frame('case_item', start, end, kids);
  }

  /** case_item statements with the esac-argument guard active (see
   *  caseItemDepth). */
  private parseCaseItemStatements(): Frame[] {
    this.caseItemDepth++;
    try {
      return this.parseStatementList({ stopWords: STOP_ESAC, stopOps: CASE_TERMINATION_OPS });
    } finally {
      this.caseItemDepth--;
    }
  }

  /** function_definition: (`function`)? name (`()`)? body redirect?
   *  The body is a compound_statement, subshell, test_command or
   *  if_statement (the grammar's full choice). */
  private parseFunctionDefinition(): Frame {
    const kids: Frame[] = [];
    const first = this.lexer.next();
    if (this.tokenText(first) === 'function') {
      kids.push(this.anon('function', first.start, first.end));
      const nameToken = this.lexer.peek();
      if (nameToken.type === 'word') {
        this.lexer.next();
        kids.push(this.frame('word', nameToken.start, nameToken.end));
      } else {
        this.hasError = true; // missing function name
      }
      this.consumeParenPair(kids);
    } else {
      kids.push(this.frame('word', first.start, first.end));
      this.consumeParenPair(kids);
    }
    // Blank lines/comments may sit between the header and the body.
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'newline') {
        this.lexer.next();
        this.completeHeredocs(token.heredocBodies);
        continue;
      }
      if (token.type === 'comment') {
        this.lexer.next();
        kids.push(this.frame('comment', token.start, token.end));
        continue;
      }
      break;
    }
    const token = this.lexer.peek();
    if (token.type === 'word' && this.tokenText(token) === '{') {
      kids.push(this.parseCompoundStatement());
    } else if (token.type === 'op' && this.tokenText(token) === '(') {
      kids.push(this.parseSubshell());
    } else if (token.type === 'word' && this.tokenText(token) === '[') {
      kids.push(this.parseTestCommand());
    } else if (token.type === 'word' && this.tokenText(token) === 'if') {
      kids.push(this.parseIfStatement());
    } else {
      this.hasError = true; // missing function body
    }
    // Optional single redirect (file_redirect or herestring).
    const redirect = this.lexer.peek();
    if (redirect.type === 'io_number') {
      kids.push(this.parseRedirect());
    } else if (redirect.type === 'op') {
      const op = this.tokenText(redirect);
      if (isFileRedirectOp(op) || op === '<<<') {
        kids.push(this.parseRedirect());
      }
    }
    return this.frame('function_definition', kids[0]!.start, this.endOf(kids, first.end), kids);
  }

  /** Consume a `(` `)` pair (blanks allowed between) as anonymous children
   *  when present. */
  private consumeParenPair(kids: Frame[]): void {
    const open = this.lexer.peek();
    if (open.type !== 'op' || this.tokenText(open) !== '(') return;
    const close = this.lexer.peekAt(1);
    if (close.type !== 'op' || this.tokenText(close) !== ')') return;
    this.lexer.next();
    this.lexer.next();
    kids.push(this.anon('(', open.start, open.end));
    kids.push(this.anon(')', close.start, close.end));
  }

  /** Lookahead for the `name() body` function form: a non-reserved word
   *  followed by `(` `)` and a valid body start (`{`, `(`, `[`, `if`),
   *  possibly across newlines. Without a valid body start the tokens belong
   *  to a plain command (`foo () ls` is command + ERROR in the reference). */
  private isFunctionDefinitionAhead(): boolean {
    const name = this.lexer.peek();
    const text = this.tokenText(name);
    if (!IDENTIFIER_RE.test(text) || RESERVED_WORD_SET.has(text)) return false;
    const open = this.lexer.peekAt(1);
    if (open.type !== 'op' || this.tokenText(open) !== '(') return false;
    const close = this.lexer.peekAt(2);
    if (close.type !== 'op' || this.tokenText(close) !== ')') return false;
    for (let n = 3; ; n++) {
      const token = this.lexer.peekAt(n);
      if (token.type === 'newline' || token.type === 'comment') continue;
      if (token.type === 'op' && this.tokenText(token) === '(') return true;
      if (token.type === 'word') {
        const word = this.tokenText(token);
        return word === '{' || word === '[' || word === 'if';
      }
      return false;
    }
  }

  /** declaration_command: (`declare` | `typeset` | `export` | `readonly` |
   *  `local`) (variable_assignment | literal | variable_name)* */
  private parseDeclarationCommand(): Frame {
    const kwToken = this.lexer.next();
    const kids: Frame[] = [this.anon(this.tokenText(kwToken), kwToken.start, kwToken.end)];
    for (;;) {
      const token = this.lexer.peek();
      if (token.type !== 'word') break;
      const text = this.tokenText(token);
      if (ASSIGNMENT_RE.test(text)) {
        this.lexer.next();
        kids.push(this.parseVariableAssignment(token));
      } else if (this.isSubscriptAssignmentAhead(token)) {
        kids.push(this.parseSubscriptAssignment());
      } else if (IDENTIFIER_RE.test(text)) {
        this.lexer.next();
        kids.push(this.frame('variable_name', token.start, token.end));
      } else {
        kids.push(this.parseWordArgument());
      }
    }
    return this.frame('declaration_command', kwToken.start, this.endOf(kids, kwToken.end), kids);
  }

  /** unset_command: (`unset` | `unsetenv`) (literal | variable_name)* */
  private parseUnsetCommand(): Frame {
    const kwToken = this.lexer.next();
    const kids: Frame[] = [this.anon(this.tokenText(kwToken), kwToken.start, kwToken.end)];
    for (;;) {
      const token = this.lexer.peek();
      if (token.type !== 'word') break;
      const text = this.tokenText(token);
      if (IDENTIFIER_RE.test(text)) {
        this.lexer.next();
        kids.push(this.frame('variable_name', token.start, token.end));
      } else {
        kids.push(this.parseWordArgument());
      }
    }
    return this.frame('unset_command', kwToken.start, this.endOf(kids, kwToken.end), kids);
  }

  // --------------------------------------------------------------- commands

  /**
   * command: leading variable_assignment / redirect prefix, command_name,
   * then arguments, inline herestring redirects and a trailing subshell
   * (`foo (ls)` keeps the subshell inside the command, as the reference
   * does). Returns null when no command name is present and nothing was
   * consumed; a nameless prefix is assembled into variable_assignment(s) /
   * redirected_statement here.
   */
  private parseCommand(): Frame | null {
    const prefix: Frame[] = [];
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'word' && ASSIGNMENT_RE.test(this.tokenText(token))) {
        this.lexer.next();
        prefix.push(this.parseVariableAssignment(token));
        continue;
      }
      if (token.type === 'word' && this.isSubscriptAssignmentAhead(token)) {
        prefix.push(this.parseSubscriptAssignment());
        continue;
      }
      // Prefix redirects take exactly one destination so a following word
      // still becomes the command_name (`> a cmd x`). Heredoc operators are
      // left for the trailing-redirect path.
      if (token.type === 'io_number') {
        prefix.push(this.parseRedirect(1));
        continue;
      }
      if (token.type === 'op') {
        const op = this.tokenText(token);
        if (isFileRedirectOp(op) || op === '<<<') {
          prefix.push(this.parseRedirect(1));
          continue;
        }
      }
      break;
    }
    if (this.lexer.peek().type !== 'word') {
      if (prefix.length === 0) return null;
      return this.assembleNamelessPrefix(prefix);
    }
    const start = prefix.length > 0 ? prefix[0]!.start : this.lexer.peek().start;
    // The name merges adjacent word tokens (the lexer splits { } [ ] out as
    // single-character tokens): `{1..3}` or `cmd{x}` is one name.
    const [nameStart, nameEnd] = this.consumeWordRun();
    const name = this.frame('command_name', nameStart, nameEnd, [this.parseLiteral(nameStart, nameEnd)]);
    const command = this.frame('command', start, nameEnd, [...prefix, name]);
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'word') {
        // Inside a case_item, `esac` closes the item rather than becoming
        // an argument (see caseItemDepth).
        if (this.caseItemDepth > 0 && this.tokenText(token) === 'esac') break;
        for (const argument of this.parseCommandArgument()) {
          this.addKid(command, argument);
          command.end = argument.end;
        }
        continue;
      }
      if (token.type === 'op' && this.tokenText(token) === '<<<') {
        const herestring = this.parseHerestringRedirect(null);
        this.addKid(command, herestring);
        command.end = herestring.end;
        continue;
      }
      if (token.type === 'op' && this.tokenText(token) === '(') {
        const subshell = this.parseSubshell();
        this.addKid(command, subshell);
        command.end = subshell.end;
        continue;
      }
      break;
    }
    return command;
  }

  /** Consume a run of adjacent word tokens; returns [start, end). */
  private consumeWordRun(): [number, number] {
    const first = this.lexer.next();
    let end = first.end;
    for (;;) {
      const token = this.lexer.peek();
      if (token.type !== 'word' || token.start !== end) break;
      this.lexer.next();
      end = token.end;
    }
    return [first.start, end];
  }

  /** One command argument: normally one literal, but `$"…"` (translated
   *  string) is TWO arguments — an anonymous `$` plus the string — because
   *  a bare dollar cannot start a concatenation in the reference grammar
   *  (tree-sitter-bash 0.25.0 never produces translated_string). */
  private parseCommandArgument(): Frame[] {
    const [start, end] = this.consumeWordRun();
    if (this.source[start] === '$' && this.source[start + 1] === '"' && start + 1 < end) {
      return [this.anon('$', start, start + 1), this.parseLiteral(start + 1, end)];
    }
    return [this.parseLiteral(start, end)];
  }

  /** A prefix of assignments/redirects with no command name:
   *  `FOO=bar`, `A=1 B=2`, `> out`, `> out FOO=bar`. */
  private assembleNamelessPrefix(prefix: Frame[]): Frame {
    const assignments = prefix.filter((f) => f.type === 'variable_assignment');
    if (assignments.length === prefix.length) {
      if (prefix.length === 1) return prefix[0]!;
      return this.frame('variable_assignments', prefix[0]!.start, prefix.at(-1)!.end, prefix);
    }
    return this.frame('redirected_statement', prefix[0]!.start, prefix.at(-1)!.end, prefix);
  }

  /** True when a subscripted assignment (`arr[0]=x`, `a[i+1]+=2`) starts at
   *  the peeked word token. */
  private isSubscriptAssignmentAhead(token: Token): boolean {
    if (!IDENTIFIER_RE.test(this.tokenText(token))) return false;
    return SUBSCRIPT_ASSIGNMENT_RE.test(this.source.slice(token.start));
  }

  /** variable_assignment with a subscript name: `arr[0]=x`, `a[i+1]+=2`.
   *  The tokens are the name, `[`, index pieces, `]` and a word starting
   *  with the operator; ranges come from a regex over the source. */
  private parseSubscriptAssignment(): Frame {
    const start = this.lexer.peek().start;
    const match = SUBSCRIPT_ASSIGNMENT_RE.exec(this.source.slice(start))!;
    const nameEnd = start + match[1]!.length;
    const indexStart = nameEnd + 1;
    const indexEnd = indexStart + match[2]!.length;
    const opStart = indexEnd + 1;
    const opEnd = opStart + match[3]!.length;
    let valueEnd = opEnd;
    // Consume tokens covering [start, opEnd) — the last one may extend past
    // the operator into the value (`=x"y"` is one word token).
    for (;;) {
      const token = this.lexer.peek();
      if (token.start >= opEnd) break;
      this.lexer.next();
      valueEnd = Math.max(valueEnd, token.end);
    }
    // Merge following adjacent word tokens into the value.
    for (;;) {
      const token = this.lexer.peek();
      if (token.type !== 'word' || token.start !== valueEnd) break;
      this.lexer.next();
      valueEnd = token.end;
    }
    const subscriptKids: Frame[] = [this.frame('variable_name', start, nameEnd), this.anon('[', nameEnd, indexStart)];
    if (indexEnd > indexStart) {
      subscriptKids.push(this.parseLiteral(indexStart, indexEnd));
    } else {
      this.hasError = true; // empty subscript index
    }
    subscriptKids.push(this.anon(']', indexEnd, opStart));
    const kids: Frame[] = [
      this.frame('subscript', start, opStart, subscriptKids),
      this.anon(match[3]!, opStart, opEnd),
    ];
    if (valueEnd > opEnd) {
      kids.push(this.parseLiteral(opEnd, valueEnd));
    }
    return this.frame('variable_assignment', start, valueEnd, kids);
  }

  /** variable_assignment: NAME ( = | += ) value — the word token is split
   *  into variable_name, the operator, and a value parsed from the rest of
   *  the token plus any ADJACENT word tokens (the lexer splits { } [ ] out
   *  as single-character tokens, so `x={1..5}` and `x=a{b}` are single
   *  assignments). An empty value followed immediately by `(` is an array
   *  literal (`arr=(a b)`). */
  private parseVariableAssignment(token: Token): Frame {
    const text = this.tokenText(token);
    const match = ASSIGNMENT_SPLIT_RE.exec(text)!;
    const nameEnd = token.start + match[1]!.length;
    const opEnd = nameEnd + match[2]!.length;
    const kids: Frame[] = [
      this.frame('variable_name', token.start, nameEnd),
      this.anon(match[2]!, nameEnd, opEnd),
    ];
    let valueEnd = token.end;
    for (;;) {
      const next = this.lexer.peek();
      if (next.type !== 'word' || next.start !== valueEnd) break;
      this.lexer.next();
      valueEnd = next.end;
    }
    if (valueEnd > opEnd) {
      kids.push(this.parseLiteral(opEnd, valueEnd));
      return this.frame('variable_assignment', token.start, valueEnd, kids);
    }
    const next = this.lexer.peek();
    if (next.type === 'op' && this.tokenText(next) === '(' && next.start === token.end) {
      const array = this.parseArray();
      kids.push(array);
      return this.frame('variable_assignment', token.start, array.end, kids);
    }
    return this.frame('variable_assignment', token.start, token.end, kids);
  }

  /** array: `(` literal* `)` — the elements of an array assignment. */
  private parseArray(): Frame {
    const open = this.lexer.next();
    const kids: Frame[] = [this.anon('(', open.start, open.end)];
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'word') {
        kids.push(this.parseWordArgument());
        continue;
      }
      if (token.type === 'newline') {
        this.lexer.next();
        this.completeHeredocs(token.heredocBodies);
        continue;
      }
      if (token.type === 'comment') {
        this.lexer.next();
        kids.push(this.frame('comment', token.start, token.end));
        continue;
      }
      if (token.type === 'op' && this.tokenText(token) === ')') {
        this.lexer.next();
        kids.push(this.anon(')', token.start, token.end));
        return this.frame('array', open.start, token.end, kids);
      }
      this.hasError = true; // unterminated array
      return this.frame('array', open.start, this.endOf(kids, open.end), kids);
    }
  }

  // --------------------------------------------------------------- redirect

  /** Parse one redirect with an optional io_number descriptor prefix already
   *  peeked. Dispatches to file_redirect / herestring / heredoc handling.
   *  `maxDestinations` limits greedy destination consumption (command-prefix
   *  redirects take exactly one). */
  private parseRedirect(maxDestinations = Number.POSITIVE_INFINITY): Frame {
    let descriptor: Frame | null = null;
    let token = this.lexer.peek();
    if (token.type === 'io_number') {
      this.lexer.next();
      descriptor = this.frame('file_descriptor', token.start, token.end);
      token = this.lexer.peek();
    }
    if (token.type !== 'op') {
      // io_number not followed by an operator — recover.
      this.hasError = true;
      const stray = descriptor ?? this.frame('ERROR', token.start, token.end);
      return this.frame('ERROR', stray.start, stray.end, descriptor === null ? [] : [stray]);
    }
    const op = this.tokenText(token);
    if (op === '<<' || op === '<<-') {
      return this.noHeredoc ? this.parseBrokenHeredoc(descriptor) : this.parseHeredocRedirect(descriptor);
    }
    if (op === '<<<') return this.parseHerestringRedirect(descriptor);
    if (isFileRedirectOp(op)) return this.parseFileRedirect(descriptor, maxDestinations);
    this.hasError = true;
    const stray = descriptor ?? this.anon(op, token.start, token.end);
    return this.frame('ERROR', stray.start, stray.end, [stray]);
  }

  /** file_redirect: [fd] op destination* — `>&-`/`<&-` take no destination.
   *  In command-prefix position only one destination is taken (`> a cmd x`
   *  makes `cmd` the command_name); after the command name the redirect is
   *  greedy, matching tree-sitter-bash (`cmd > out arg` puts both words in
   *  the redirect). */
  private parseFileRedirect(descriptor: Frame | null, maxDestinations = Number.POSITIVE_INFINITY): Frame {
    const opToken = this.lexer.next();
    const op = this.tokenText(opToken);
    const kids: Frame[] = [];
    if (descriptor !== null) kids.push(descriptor);
    kids.push(this.anon(op, opToken.start, opToken.end));
    let end = opToken.end;
    if (op !== '>&-' && op !== '<&-') {
      let destinations = 0;
      while (destinations < maxDestinations && this.lexer.peek().type === 'word') {
        const destination = this.parseWordArgument();
        kids.push(destination);
        end = destination.end;
        destinations++;
      }
      if (destinations === 0) this.hasError = true; // missing destination
    }
    return this.frame('file_redirect', descriptor?.start ?? opToken.start, end, kids);
  }

  /** herestring_redirect: [fd] `<<<` literal */
  private parseHerestringRedirect(descriptor: Frame | null): Frame {
    const opToken = this.lexer.next();
    const kids: Frame[] = [];
    if (descriptor !== null) kids.push(descriptor);
    kids.push(this.anon('<<<', opToken.start, opToken.end));
    let end = opToken.end;
    if (this.lexer.peek().type === 'word') {
      const value = this.parseWordArgument();
      kids.push(value);
      end = value.end;
    } else {
      this.hasError = true;
    }
    return this.frame('herestring_redirect', descriptor?.start ?? opToken.start, end, kids);
  }

  /**
   * heredoc_redirect: [fd] (`<<` | `<<-`) heredoc_start, then the rest of
   * the line (arguments, redirects, a pipeline or &&/|| tail, and `;`/`&`
   * separated follow-up statements) absorbed into the redirect — matching
   * tree-sitter-bash's grammar, which swallows all of these into
   * heredoc_redirect.
   *
   * Only ONE heredoc may be registered per line region: a second `<<`
   * (or a `<<` inside a swallowed follow-up statement) cannot be
   * represented as a tree — its body would have to sit inside a node whose
   * range interleaves with the first heredoc's siblings. tree-sitter-bash
   * 0.25.0 errors on `cat <<A <<B` for the same reason. The parser degrades
   * such operators to ERROR nodes (see parseBrokenHeredoc) and leaves the
   * "body" lines to be parsed as ordinary commands, mirroring the
   * reference's recovery shape.
   *
   * The body/end nodes are attached later by completeHeredocs(), when the
   * lexer reports the bodies scanned after the end of the line.
   */
  private parseHeredocRedirect(descriptor: Frame | null): Frame {
    const opToken = this.lexer.next();
    const op = this.tokenText(opToken);
    const kids: Frame[] = [];
    if (descriptor !== null) kids.push(descriptor);
    kids.push(this.anon(op, opToken.start, opToken.end));
    const redirect = this.frame('heredoc_redirect', descriptor?.start ?? opToken.start, opToken.end, kids);
    const startToken = this.lexer.peek();
    if (startToken.type !== 'word') {
      this.hasError = true; // missing delimiter
      return redirect;
    }
    this.lexer.next();
    this.addKid(redirect, this.frame('heredoc_start', startToken.start, startToken.end));
    redirect.end = startToken.end;
    const spec = extractHeredocSpec(this.tokenText(startToken), op === '<<-');
    this.lexer.queueHeredoc(spec);
    this.heredocQueue.push({ frame: redirect, spec });
    const saved = this.noHeredoc;
    this.noHeredoc = true;
    try {
      this.swallowAfterHeredoc(redirect);
    } finally {
      this.noHeredoc = saved;
    }
    return redirect;
  }

  /** A `<<`/`<<-` where another heredoc is already open on this line (see
   *  parseHeredocRedirect): recover with an ERROR node and do NOT queue a
   *  body, so the following lines parse as ordinary commands. */
  private parseBrokenHeredoc(descriptor: Frame | null): Frame {
    this.hasError = true;
    const opToken = this.lexer.next();
    const kids: Frame[] = [];
    if (descriptor !== null) kids.push(descriptor);
    kids.push(this.anon(this.tokenText(opToken), opToken.start, opToken.end));
    let end = opToken.end;
    if (this.lexer.peek().type === 'word') {
      const word = this.parseWordArgument();
      kids.push(word);
      end = word.end;
    }
    return this.frame('ERROR', descriptor?.start ?? opToken.start, end, kids);
  }

  /** Absorb the rest of the heredoc's line into the redirect frame. */
  private swallowAfterHeredoc(redirect: Frame): void {
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'word') {
        const argument = this.parseWordArgument();
        this.addKid(redirect, argument);
        redirect.end = argument.end;
        continue;
      }
      if (token.type === 'io_number') {
        const frame = this.parseRedirect();
        this.addKid(redirect, frame);
        redirect.end = frame.end;
        continue;
      }
      if (token.type !== 'op') return;
      const op = this.tokenText(token);
      if (op === '<<' || op === '<<-') {
        const broken = this.parseRedirect(); // second heredoc: ERROR recovery
        this.addKid(redirect, broken);
        redirect.end = broken.end;
        continue;
      }
      if (isFileRedirectOp(op) || op === '<<<') {
        const frame = this.parseRedirect();
        this.addKid(redirect, frame);
        redirect.end = frame.end;
        continue;
      }
      if (op === '|' || op === '|&') {
        this.lexer.next();
        const kids: Frame[] = [this.anon(op, token.start, token.end)];
        let end = token.end;
        if (this.isStatementStart(this.lexer.peek())) {
          const inner = this.parsePipelineTail(this.parseStatementNotPipeline());
          kids.push(inner);
          end = inner.end;
        } else {
          this.hasError = true;
        }
        const pipeline = this.frame('pipeline', token.start, end, kids);
        this.addKid(redirect, pipeline);
        redirect.end = pipeline.end;
        continue;
      }
      if (op === '&&' || op === '||') {
        this.lexer.next();
        this.addKid(redirect, this.anon(op, token.start, token.end));
        redirect.end = token.end;
        if (this.isStatementStart(this.lexer.peek())) {
          const right = this.parsePipeline();
          this.addKid(redirect, right);
          redirect.end = right.end;
        } else {
          this.hasError = true;
        }
        continue;
      }
      if (op === ';' || op === '&' || op === ';;') {
        // Follow-up statements on the same line (e.g. `cat <<E; echo x`)
        // are absorbed so the tree stays overlap-free once the body (which
        // textually follows the whole line) is attached.
        this.lexer.next();
        this.addKid(redirect, this.anon(op, token.start, token.end));
        redirect.end = token.end;
        if (this.isStatementStart(this.lexer.peek())) {
          const statement = this.parseList();
          this.addKid(redirect, statement);
          redirect.end = statement.end;
        }
        continue;
      }
      return;
    }
  }

  /** Attach scanned bodies to pending heredoc redirects, in queue order. */
  private completeHeredocs(bodies: HeredocBody[]): void {
    for (const body of bodies) {
      const pending = this.heredocQueue.shift();
      if (pending === undefined) continue;
      const { frame, spec } = pending;
      const content = spec.quoted ? [] : this.parseHeredocContent(body.bodyStart, body.bodyEnd);
      this.addKid(frame, this.frame('heredoc_body', body.bodyStart, body.bodyEnd, content));
      let end = body.bodyEnd;
      if (body.found) {
        this.addKid(frame, this.frame('heredoc_end', body.endStart, body.endEnd));
        end = body.endEnd;
      } else {
        this.hasError = true; // unterminated heredoc
      }
      frame.end = end;
      // Ancestors were finalized before the body existed; extend them.
      for (let parent = frame.parent; parent !== null; parent = parent.parent) {
        if (parent.end < end) parent.end = end;
      }
    }
  }

  /** Pendings that never got a body (scope ended first): close them empty. */
  private failOpenHeredocs(): void {
    for (const pending of this.heredocQueue.splice(0)) {
      this.hasError = true;
      const at = pending.frame.end;
      this.addKid(pending.frame, this.frame('heredoc_body', at, at));
    }
  }

  // ------------------------------------------------------------------ words

  /** Parse one argument/destination word. Adjacent word tokens (the lexer
   *  splits { } [ ] out as single-character tokens) merge back into a single
   *  literal, so `a{b}` is one concatenation argument. */
  private parseWordArgument(): Frame {
    const [start, end] = this.consumeWordRun();
    return this.parseLiteral(start, end);
  }

  /**
   * _literal over a source range: a single word/number/string/expansion/…,
   * or a concatenation of adjacent pieces. The single characters { } [ ]
   * become their own word pieces, matching tree-sitter-bash's
   * _special_character alias — except `{N..M}` (digits only), which is a
   * brace_expression, and a leading `((…))`, which is an arithmetic command.
   *
   * Guarded by literalDepth: parseLiteral ↔ parseString / parseExpansion
   * recurse through parseDollar, and unlike command substitutions (which
   * spawn depth-tracked sub-parsers) that chain stays inside one Parser, so
   * it needs its own counter.
   */
  private parseLiteral(start: number, end: number): Frame {
    if (this.literalDepth >= MAX_PARSE_DEPTH) {
      this.hasError = true;
      return this.frame('ERROR', start, end);
    }
    this.literalDepth++;
    try {
      return this.parseLiteralPieces(start, end);
    } finally {
      this.literalDepth--;
    }
  }

  private parseLiteralPieces(start: number, end: number): Frame {
    const pieces: Frame[] = [];
    let i = start;
    while (i < end) {
      this.budget.progress();
      const ch = this.source[i]!;
      if (ch === '"') {
        const [piece, next] = this.parseString(i, end);
        pieces.push(piece);
        i = next;
        continue;
      }
      if (ch === "'") {
        const close = skipSingleQuoted(this.source, this.budget, i, end);
        if (close >= end && this.source[close - 1] !== "'") this.hasError = true; // unterminated raw string
        pieces.push(this.frame('raw_string', i, close));
        i = close;
        continue;
      }
      if (ch === '`') {
        const [piece, next] = this.parseBacktickSubstitution(i, end);
        pieces.push(piece);
        i = next;
        continue;
      }
      if (ch === '$') {
        // $"…" at the START of a literal is a translated_string (the
        // reference produces it everywhere except command-argument
        // position, where parseCommandArgument splits the bare `$` and the
        // string into two arguments). Mid-literal it stays a bare `$` plus
        // a string piece inside the concatenation.
        if (this.source[i + 1] === '"' && i === start) {
          const [translated, next] = this.parseString(i + 1, end);
          pieces.push(this.frame('translated_string', i, next, [this.anon('$', i, i + 1), translated]));
          i = next;
          continue;
        }
        const dollar = this.parseDollar(i, end);
        if (dollar !== null) {
          pieces.push(dollar[0]);
          i = dollar[1];
        } else {
          // Bare `$` (not followed by anything expandable), e.g. the `$` of
          // a mid-literal $"…" (see above).
          pieces.push(this.anon('$', i, i + 1));
          i++;
        }
        continue;
      }
      if ((ch === '<' || ch === '>') && this.source[i + 1] === '(' && i + 1 < end) {
        const [piece, next] = this.parseProcessSubstitution(i, end);
        pieces.push(piece);
        i = next;
        continue;
      }
      if (ch === '(' && this.source[i + 1] === '(' && i + 1 < end) {
        const [piece, next] = this.parseParenArithmetic(i, end);
        pieces.push(piece);
        i = next;
        continue;
      }
      if (ch === '{') {
        const brace = BRACE_EXPRESSION_RE.exec(this.source.slice(i, end));
        if (brace !== null) {
          const [full, low, high] = brace;
          const lowStart = i + 1;
          const highStart = lowStart + low!.length + 2;
          const close = highStart + high!.length;
          pieces.push(
            this.frame('brace_expression', i, i + full.length, [
              this.anon('{', i, lowStart),
              this.frame('number', lowStart, lowStart + low!.length),
              this.anon('..', lowStart + low!.length, highStart),
              this.frame('number', highStart, close),
              this.anon('}', close, close + 1),
            ]),
          );
          i += full.length;
          continue;
        }
        pieces.push(this.frame('word', i, i + 1));
        i++;
        continue;
      }
      if (ch === '}' || ch === '[' || ch === ']') {
        pieces.push(this.frame('word', i, i + 1));
        i++;
        continue;
      }
      // Bare run of ordinary word characters (escapes included as-is).
      let j = i;
      let sinceTick = 0;
      while (j < end) {
        if (++sinceTick >= SCAN_TICK_INTERVAL) {
          this.budget.progress();
          sinceTick = 0;
        }
        const next = this.source[j]!;
        if (next === '"' || next === "'" || next === '`' || next === '$') break;
        if (next === '{' || next === '}' || next === '[' || next === ']') break;
        if ((next === '<' || next === '>') && this.source[j + 1] === '(' && j + 1 < end) break;
        if (next === '(' && this.source[j + 1] === '(' && j + 1 < end) break;
        if (next === '\\' && j + 1 < end) {
          j += 2;
          continue;
        }
        j++;
      }
      if (j === i) j++; // defensive: never stall
      // A bare run that is exactly a number is a number node even as one
      // piece of a concatenation (`a[2]b` → word + number + word).
      const numeric = NUMBER_RE.test(this.text(i, j));
      pieces.push(this.frame(numeric ? 'number' : 'word', i, j));
      i = j;
    }
    if (pieces.length === 1) {
      const only = pieces[0]!;
      if (only.type === 'word' && NUMBER_RE.test(this.text(only.start, only.end))) {
        return this.frame('number', only.start, only.end);
      }
      return only;
    }
    return this.frame('concatenation', start, end, pieces);
  }

  /** string: " … " with string_content chunks and expansions inside. */
  private parseString(start: number, rangeEnd: number): [Frame, number] {
    const string = this.frame('string', start, start + 1, [this.anon('"', start, start + 1)]);
    let chunkStart = start + 1;
    let i = start + 1;
    const flushChunk = (upto: number): void => {
      if (upto > chunkStart) {
        this.addKid(string, this.frame('string_content', chunkStart, upto));
      }
    };
    let sinceTick = 0;
    while (i < rangeEnd) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const ch = this.source[i]!;
      if (ch === '"') {
        flushChunk(i);
        this.addKid(string, this.anon('"', i, i + 1));
        string.end = i + 1;
        return [string, i + 1];
      }
      if (ch === '\\') {
        i += 2; // escaped characters stay inside the current content chunk
        continue;
      }
      if (ch === '$') {
        const dollar = this.parseDollar(i, rangeEnd);
        if (dollar !== null) {
          flushChunk(i);
          this.addKid(string, dollar[0]);
          i = dollar[1];
          chunkStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (ch === '`') {
        flushChunk(i);
        const [piece, next] = this.parseBacktickSubstitution(i, rangeEnd);
        this.addKid(string, piece);
        i = next;
        chunkStart = i;
        continue;
      }
      i++;
    }
    // Unterminated string: keep the partial node, flag the error.
    this.hasError = true;
    flushChunk(rangeEnd);
    string.end = rangeEnd;
    return [string, rangeEnd];
  }

  /** Dispatch a $-construct at `i`: simple_expansion, expansion,
   *  command_substitution, arithmetic_expansion, or ansi_c_string. Returns
   *  null for a bare `$` (including the `$` of a mid-literal $"…" — see
   *  parseLiteralPieces for the translated_string rule). */
  private parseDollar(i: number, rangeEnd: number): [Frame, number] | null {
    const next = this.source[i + 1];
    if (next === '(' && i + 1 < rangeEnd) {
      if (this.source[i + 2] === '(') return this.parseArithmeticExpansion(i, rangeEnd);
      return this.parseCommandSubstitution(i, rangeEnd);
    }
    if (next === '{' && i + 1 < rangeEnd) return this.parseExpansion(i, rangeEnd);
    if (next === '[' && i + 1 < rangeEnd) return this.parseBracketArithmetic(i, rangeEnd);
    if (next === "'" && i + 1 < rangeEnd) return this.parseAnsiCString(i, rangeEnd);
    if (next !== undefined && /[\w]/.test(next)) {
      let j = i + 1;
      while (j < rangeEnd && /[\w]/.test(this.source[j]!)) j++;
      // `$0` is a special_variable_name; other digits are variable_name
      // (`$1`, and `${10}` below) — matching the reference grammar, whose
      // \w+ rule wins for everything except the standalone 0.
      if (j === i + 2 && next === '0') {
        return [
          this.frame('simple_expansion', i, j, [this.anon('$', i, i + 1), this.frame('special_variable_name', i + 1, j)]),
          j,
        ];
      }
      const expansion = this.frame('simple_expansion', i, j, [
        this.anon('$', i, i + 1),
        this.frame('variable_name', i + 1, j),
      ]);
      return [expansion, j];
    }
    if (next !== undefined && i + 1 < rangeEnd && SPECIAL_VARIABLE_CHARS.includes(next)) {
      const expansion = this.frame('simple_expansion', i, i + 2, [
        this.anon('$', i, i + 1),
        this.frame('special_variable_name', i + 1, i + 2),
      ]);
      return [expansion, i + 2];
    }
    return null;
  }

  /** ansi_c_string: $' … ' — one leaf node, \' is an escaped quote. */
  private parseAnsiCString(i: number, rangeEnd: number): [Frame, number] {
    let j = i + 2;
    let sinceTick = 0;
    while (j < rangeEnd) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const ch = this.source[j]!;
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === "'") {
        return [this.frame('ansi_c_string', i, j + 1), j + 1];
      }
      j++;
    }
    this.hasError = true; // unterminated ANSI-C string
    return [this.frame('ansi_c_string', i, rangeEnd), rangeEnd];
  }

  /**
   * expansion: ${ … } with optional prefix operators (! #), a variable_name
   * / special_variable_name / subscript, and an optional infix operator
   * whose value layout follows the reference:
   *   # ## % %%     removal — the pattern is a regex node (quotes become
   *                 string/raw_string pieces)
   *   / // /# /%    replacement — regex pattern, optional `/` + literal
   *   ^ ^^ , ,,     case modification — optional regex
   *   @X            transformation — two anonymous operator nodes
   *   :             max length — arithmetic values around an optional `:`
   *   :- := :+ :? - = + ?   default/assign/… — a word/concatenation value
   *
   * Guarded by literalDepth directly (not only via parseLiteral): the
   * pattern → string → $ → expansion recursion cycle bypasses parseLiteral
   * and would otherwise overflow the stack on pathological nesting.
   */
  private parseExpansion(i: number, rangeEnd: number): [Frame, number] {
    if (this.literalDepth >= MAX_PARSE_DEPTH) {
      this.hasError = true;
      const scan = this.scanBalanced(i + 1, rangeEnd, '{', '}');
      return [this.frame('ERROR', i, scan.end), scan.end];
    }
    this.literalDepth++;
    try {
      return this.parseExpansionInner(i, rangeEnd);
    } finally {
      this.literalDepth--;
    }
  }

  private parseExpansionInner(i: number, rangeEnd: number): [Frame, number] {
    const scan = this.scanBalanced(i + 1, rangeEnd, '{', '}');
    const close = scan.end;
    const terminated = scan.balanced;
    if (!terminated) this.hasError = true;
    const innerEnd = terminated ? close - 1 : close;
    const expansion = this.frame('expansion', i, close, [this.anon('${', i, i + 2)]);
    let j = i + 2;
    // Prefix operators: ${#v} (length), ${!v} (indirect).
    let bangPrefix = false;
    while (j < innerEnd && (this.source[j] === '#' || this.source[j] === '!')) {
      const after = this.source[j + 1];
      if (after === undefined || j + 1 >= innerEnd || !/[\w@*#?$!-]/.test(after)) break;
      if (this.source[j] === '!') bangPrefix = true;
      this.addKid(expansion, this.anon(this.source[j]!, j, j + 1));
      j++;
    }
    // The variable itself.
    let hasName = false;
    if (j < innerEnd && /[\w]/.test(this.source[j]!)) {
      let nameEnd = j;
      while (nameEnd < innerEnd && /[\w]/.test(this.source[nameEnd]!)) nameEnd++;
      // ${0} is a special_variable_name; other digits are variable_name.
      const special = nameEnd === j + 1 && this.source[j] === '0';
      this.addKid(expansion, this.frame(special ? 'special_variable_name' : 'variable_name', j, nameEnd));
      j = nameEnd;
      hasName = true;
    } else if (j < innerEnd && SPECIAL_VARIABLE_CHARS.includes(this.source[j]!)) {
      this.addKid(expansion, this.frame('special_variable_name', j, j + 1));
      j++;
      hasName = true;
    }
    // Subscript: ${a[0]} — replaces the bare variable_name child.
    if (j < innerEnd && this.source[j] === '[' && hasName) {
      const sub = this.scanBalanced(j, rangeEnd, '[', ']');
      const subEnd = sub.end;
      if (!sub.balanced) this.hasError = true;
      const indexEnd = sub.balanced ? subEnd - 1 : subEnd;
      const variable = expansion.children.pop()!;
      const subscript = this.frame('subscript', variable.start, subEnd, [
        variable,
        this.anon('[', j, j + 1),
      ]);
      if (indexEnd > j + 1) {
        this.addKid(subscript, this.parseLiteral(j + 1, indexEnd));
      } else {
        this.hasError = true;
      }
      if (sub.balanced) this.addKid(subscript, this.anon(']', subEnd - 1, subEnd));
      this.addKid(expansion, subscript);
      j = subEnd;
    }
    // ${!prefix*} / ${!name@}: a trailing * or @ after an indirect name.
    if (bangPrefix && j < innerEnd && (this.source[j] === '*' || this.source[j] === '@')) {
      this.addKid(expansion, this.anon(this.source[j]!, j, j + 1));
      j++;
    }
    // Infix operator plus an optional value.
    if (j < innerEnd) {
      j = this.parseExpansionInfix(expansion, j, innerEnd);
    }
    if (terminated) this.addKid(expansion, this.anon('}', close - 1, close));
    return [expansion, close];
  }

  /** The infix part of an expansion (see parseExpansion). Returns the new
   *  scan position. */
  private parseExpansionInfix(expansion: Frame, j: number, innerEnd: number): number {
    const one = this.source[j]!;
    const two = this.source.slice(j, j + 2);
    if (two === '##' || two === '%%' || one === '#' || one === '%') {
      const operator = two === '##' || two === '%%' ? two : one;
      this.addKid(expansion, this.anon(operator, j, j + operator.length));
      return this.parseExpansionPattern(expansion, j + operator.length, innerEnd);
    }
    if (two === '//' || two === '/#' || two === '/%' || one === '/') {
      const operator = two === '//' || two === '/#' || two === '/%' ? two : one;
      this.addKid(expansion, this.anon(operator, j, j + operator.length));
      let pos = this.parseExpansionPattern(expansion, j + operator.length, innerEnd, '/');
      if (pos < innerEnd && this.source[pos] === '/') {
        this.addKid(expansion, this.anon('/', pos, pos + 1));
        pos++;
        if (pos < innerEnd) {
          this.addKid(expansion, this.parseExpansionValue(pos, innerEnd));
          pos = innerEnd;
        }
      }
      return pos;
    }
    if (two === '^^' || two === ',,' || one === '^' || one === ',') {
      const operator = two === '^^' || two === ',,' ? two : one;
      this.addKid(expansion, this.anon(operator, j, j + operator.length));
      return this.parseExpansionPattern(expansion, j + operator.length, innerEnd);
    }
    if (one === '@' && j + 1 < innerEnd) {
      this.addKid(expansion, this.anon('@', j, j + 1));
      this.addKid(expansion, this.anon(this.source[j + 1]!, j + 1, j + 2));
      return j + 2;
    }
    if (one === ':' && two !== ':-' && two !== ':=' && two !== ':+' && two !== ':?') {
      // Max length: ${v:offset:length} — arithmetic values.
      this.addKid(expansion, this.anon(':', j, j + 1));
      let pos = this.parseMaxLengthValue(expansion, j + 1, innerEnd);
      if (pos < innerEnd && this.source[pos] === ':') {
        this.addKid(expansion, this.anon(':', pos, pos + 1));
        pos = this.parseMaxLengthValue(expansion, pos + 1, innerEnd);
      }
      if (pos < innerEnd) {
        this.hasError = true; // extra content after ${v:o:l}
        this.addKid(expansion, this.parseLiteral(pos, innerEnd));
        pos = innerEnd;
      }
      return pos;
    }
    for (const operator of [':-', ':=', ':+', ':?', '-', '=', '+', '?']) {
      if (this.source.startsWith(operator, j) && j + operator.length <= innerEnd) {
        this.addKid(expansion, this.anon(operator, j, j + operator.length));
        const pos = j + operator.length;
        if (pos < innerEnd) {
          this.addKid(expansion, this.parseExpansionValue(pos, innerEnd));
        }
        return innerEnd;
      }
    }
    // Unknown infix content: keep it as a literal (and flag the error).
    this.hasError = true;
    this.addKid(expansion, this.parseLiteral(j, innerEnd));
    return innerEnd;
  }

  /** A removal/replacement pattern inside ${…}: regex chunks (raw text,
   *  spaces included) interleaved with string/raw_string pieces. `stop`
   *  optionally ends the pattern (the replacement separator `/`). */
  private parseExpansionPattern(expansion: Frame, j: number, innerEnd: number, stop?: string): number {
    let pos = j;
    while (pos < innerEnd) {
      this.budget.progress();
      const ch = this.source[pos]!;
      if (ch === '"') {
        const [piece, next] = this.parseString(pos, innerEnd);
        this.addKid(expansion, piece);
        pos = next;
        continue;
      }
      if (ch === "'") {
        const close = skipSingleQuoted(this.source, this.budget, pos, innerEnd);
        this.addKid(expansion, this.frame('raw_string', pos, close));
        pos = close;
        continue;
      }
      let k = pos;
      let sinceTick = 0;
      while (k < innerEnd && this.source[k] !== '"' && this.source[k] !== "'" && this.source[k] !== stop) {
        if (++sinceTick >= SCAN_TICK_INTERVAL) {
          this.budget.progress();
          sinceTick = 0;
        }
        if (this.source[k] === '\\' && k + 1 < innerEnd) {
          k += 2;
          continue;
        }
        k++;
      }
      if (k === pos) break; // defensive: only the stop character remains
      this.addKid(expansion, this.frame('regex', pos, k));
      pos = k;
    }
    return pos;
  }

  /** A default/assign value inside ${…} (`${v:-word}`): bare text is a word
   *  (never a number — `${v:-1}` is a word in the reference); a bare value
   *  containing a space splits into two word pieces inside a concatenation
   *  (`${v:-d e f}` → word "d" + word " e f", matching the reference's
   *  _expansion_word scanner). */
  private parseExpansionValue(start: number, end: number): Frame {
    const raw = this.text(start, end);
    if (!/["'$`\\]/.test(raw)) {
      const space = raw.indexOf(' ');
      if (space > 0) {
        return this.frame('concatenation', start, end, [
          this.frame('word', start, start + space),
          this.frame('word', start + space, end),
        ]);
      }
      return this.frame('word', start, end);
    }
    return this.parseLiteral(start, end);
  }

  /** One arithmetic value of ${v:offset:length} (up to `:` or innerEnd). */
  private parseMaxLengthValue(expansion: Frame, j: number, innerEnd: number): number {
    let end = j;
    let sinceTick = 0;
    while (end < innerEnd && this.source[end] !== ':') {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const ch = this.source[end]!;
      if (ch === '\\') {
        end += 2;
        continue;
      }
      if (ch === '$') {
        end = this.skipDollarConstruct(end, innerEnd);
        continue;
      }
      if (ch === '(') {
        end = this.scanBalanced(end, innerEnd, '(', ')').end;
        continue;
      }
      end++;
    }
    if (end > j) {
      // In max-length context a negative offset is a number literal, not a
      // unary expression (`${x: -5}` → number "-5" in the reference).
      const negative = /^\s*(-\d+)\s*$/.exec(this.text(j, end));
      if (negative !== null) {
        const start = j + this.text(j, end).indexOf('-');
        this.addKid(expansion, this.frame('number', start, start + negative[1]!.length));
        return end;
      }
      const st = this.newExprState(j, end, 'arith');
      const value = this.parseExpression(st, 0);
      if (value !== null) {
        this.addKid(expansion, value);
      }
      const leftover = this.exprLeftover(st);
      if (leftover !== null) this.addKid(expansion, leftover);
    }
    return end;
  }

  /** Skip a $-construct without building nodes (max-length scanning). */
  private skipDollarConstruct(i: number, end: number): number {
    const next = this.source[i + 1];
    if (next === '(') return this.scanBalanced(i + 1, end, '(', ')').end;
    if (next === '{') return this.scanBalanced(i + 1, end, '{', '}').end;
    if (next !== undefined && /[\w]/.test(next)) {
      let j = i + 1;
      while (j < end && /[\w]/.test(this.source[j]!)) j++;
      return j;
    }
    return i + 1 < end ? i + 2 : i + 1;
  }

  /** command_substitution: $( _statements ). The close-paren scan is
   *  case-aware (see scanBalancedStatements): a case_item pattern `)` must
   *  not close the substitution early. */
  private parseCommandSubstitution(i: number, rangeEnd: number): [Frame, number] {
    const scan = scanBalancedStatements(this.source, this.budget, i + 1, rangeEnd);
    const close = scan.end;
    if (!scan.balanced) this.hasError = true;
    const innerEnd = scan.balanced ? close - 1 : close;
    const substitution = this.frame('command_substitution', i, close, [this.anon('$(', i, i + 2)]);
    for (const child of this.parseScopedStatements(i + 2, innerEnd)) {
      this.addKid(substitution, child);
    }
    if (scan.balanced) this.addKid(substitution, this.anon(')', close - 1, close));
    return [substitution, close];
  }

  /** command_substitution: ` _statements ` (legacy backtick form). */
  private parseBacktickSubstitution(i: number, rangeEnd: number): [Frame, number] {
    const close = skipBacktick(this.source, this.budget, i, rangeEnd);
    const terminated = close > i + 1 && this.source[close - 1] === '`';
    if (!terminated) this.hasError = true;
    const innerEnd = terminated ? close - 1 : close;
    const substitution = this.frame('command_substitution', i, close, [this.anon('`', i, i + 1)]);
    if (innerEnd > i + 1) {
      for (const child of this.parseScopedStatements(i + 1, innerEnd)) {
        this.addKid(substitution, child);
      }
    }
    if (terminated) this.addKid(substitution, this.anon('`', close - 1, close));
    return [substitution, close];
  }

  /** process_substitution: ( <( | >( ) _statements ) — case-aware close
   *  scan, like command_substitution. */
  private parseProcessSubstitution(i: number, rangeEnd: number): [Frame, number] {
    const scan = scanBalancedStatements(this.source, this.budget, i + 1, rangeEnd);
    const close = scan.end;
    if (!scan.balanced) this.hasError = true;
    const innerEnd = scan.balanced ? close - 1 : close;
    const opener = this.source[i]!;
    const substitution = this.frame('process_substitution', i, close, [this.anon(`${opener}(`, i, i + 2)]);
    for (const child of this.parseScopedStatements(i + 2, innerEnd)) {
      this.addKid(substitution, child);
    }
    if (scan.balanced) this.addKid(substitution, this.anon(')', close - 1, close));
    return [substitution, close];
  }

  // ------------------------------------------------------ expression engine

  private newExprState(start: number, end: number, mode: ExprMode): ExprState {
    return { pos: start, end, mode, lookahead: null, parenDepth: 0, expectOperator: false };
  }

  private exprPeek(st: ExprState): ExprToken {
    st.lookahead ??= this.scanExprToken(st);
    return st.lookahead;
  }

  /** When unconsumed input remains in the expression state, wrap it in an
   *  ERROR node (covering the rest of the region, so no source text
   *  silently drops out of the tree) and flag the error. */
  private exprLeftover(st: ExprState): Frame | null {
    const token = this.exprPeek(st);
    if (token.kind === 'end') return null;
    this.hasError = true;
    return this.frame('ERROR', token.start, st.end);
  }

  private exprNext(st: ExprState): ExprToken {
    const token = this.exprPeek(st);
    st.lookahead = null;
    return token;
  }

  /** arithmetic_expansion: $(( expr (, expr)* )) */
  private parseArithmeticExpansion(i: number, rangeEnd: number): [Frame, number] {
    const scan = this.scanBalanced(i + 1, rangeEnd, '(', ')');
    const close = scan.end;
    // The content sits between `$((` and the final `))`.
    const closed = scan.balanced && close - 2 >= i + 3 && this.source[close - 2] === ')';
    if (!closed) this.hasError = true;
    const innerStart = Math.min(i + 3, close);
    const innerEnd = closed ? close - 2 : close;
    const expansion = this.frame('arithmetic_expansion', i, close, [this.anon('$((', i, innerStart)]);
    this.addArithmeticChildren(expansion, innerStart, innerEnd);
    if (closed) {
      this.addKid(expansion, this.anon('))', innerEnd, close));
    }
    return [expansion, close];
  }

  /** arithmetic_expansion without the `$`: (( expr )) at word position. */
  private parseParenArithmetic(i: number, rangeEnd: number): [Frame, number] {
    const scan = this.scanBalanced(i, rangeEnd, '(', ')');
    const close = scan.end;
    const closed = scan.balanced && close - 2 >= i + 2 && this.source[close - 2] === ')';
    if (!closed) this.hasError = true;
    const innerStart = Math.min(i + 2, close);
    const innerEnd = closed ? close - 2 : close;
    const expansion = this.frame('arithmetic_expansion', i, close, [this.anon('((', i, innerStart)]);
    this.addArithmeticChildren(expansion, innerStart, innerEnd);
    if (closed) {
      this.addKid(expansion, this.anon('))', innerEnd, close));
    }
    return [expansion, close];
  }

  /** arithmetic_expansion: $[ expr ] (legacy form). */
  private parseBracketArithmetic(i: number, rangeEnd: number): [Frame, number] {
    const scan = this.scanBalanced(i + 1, rangeEnd, '[', ']');
    const close = scan.end;
    if (!scan.balanced) this.hasError = true;
    const innerEnd = scan.balanced ? close - 1 : close;
    const expansion = this.frame('arithmetic_expansion', i, close, [this.anon('$[', i, i + 2)]);
    this.addArithmeticChildren(expansion, i + 2, innerEnd);
    if (scan.balanced) {
      this.addKid(expansion, this.anon(']', close - 1, close));
    }
    return [expansion, close];
  }

  /** The comma-separated expression list inside an arithmetic_expansion. */
  private addArithmeticChildren(expansion: Frame, start: number, end: number): void {
    const st = this.newExprState(start, end, 'arith');
    for (;;) {
      const expression = this.parseExpression(st, 0);
      if (expression !== null) this.addKid(expansion, expression);
      const token = this.exprPeek(st);
      if (token.kind === 'op' && token.text === ',') {
        this.exprNext(st);
        this.addKid(expansion, this.anon(',', token.start, token.end));
        continue;
      }
      break;
    }
    const leftover = this.exprLeftover(st);
    if (leftover !== null) this.addKid(expansion, leftover);
  }

  /**
   * Pratt parser for arithmetic / c-style-for / test expressions. Mirrors
   * grammar.js: left-associative binaries parse their right side at
   * level+1, `**` is right-associative only in test mode (left in
   * arithmetic), prefix -/+/~/! take their operand at level 11 (so
   * `-x + ~y` is -(x + ~y)) and prefix ++/-- at level 17, postfix ++/-- sit
   * at level 18, ternary at level 2.
   */
  private parseExpression(st: ExprState, minPrecedence: number): Frame | null {
    let left: Frame | null;
    const head = this.exprPeek(st);
    // `;` and `,` are separators (c-style for parts, comma lists), handled
    // by the caller — never operands.
    if (head.kind === 'op' && (head.text === ';' || head.text === ',')) return null;
    if (head.kind === 'op' && (head.text === '++' || head.text === '--')) {
      this.exprNext(st);
      const kids: Frame[] = [this.anon(head.text, head.start, head.end)];
      const operand = this.parseExpression(st, PREC_PREFIX);
      if (operand === null) this.hasError = true;
      else kids.push(operand);
      left = this.frame('unary_expression', head.start, this.endOf(kids, head.end), kids);
    } else if (head.kind === 'op' && (head.text === '!' || head.text === '~' || head.text === '+' || head.text === '-')) {
      this.exprNext(st);
      const kids: Frame[] = [this.anon(head.text, head.start, head.end)];
      const operand = this.parseExpression(st, PREC_UNARY);
      if (operand === null) this.hasError = true;
      else kids.push(operand);
      left = this.frame('unary_expression', head.start, this.endOf(kids, head.end), kids);
    } else if (head.kind === 'testop') {
      this.exprNext(st);
      // A test_operator with no usable operand ahead is just a word
      // (`[[ $a == -foo ]]` → word "-foo", `[[ -foo == x ]]` → word,
      // `[[ -f ]]` → word — the reference's fallback when the operator
      // reading fails).
      const after = this.exprPeek(st);
      const demote =
        after.kind === 'end' ||
        after.kind === 'rparen' ||
        (after.kind === 'op' &&
          (after.text === '=' || after.text === '==' || after.text === '!=' || after.text === '=~' || after.text === '&&' || after.text === '||'));
      if (demote) {
        left = this.frame('word', head.start, head.end);
      } else {
        const kids: Frame[] = [this.frame('test_operator', head.start, head.end)];
        const operand = this.parseExpression(st, PREC_TEST);
        if (operand === null) this.hasError = true;
        else kids.push(operand);
        left = this.frame('unary_expression', head.start, this.endOf(kids, head.end), kids);
      }
    } else {
      left = this.parseExprPrimary(st);
    }
    if (left === null) return null;
    // A complete operand: what follows is operator position (test mode).
    st.expectOperator = true;
    for (;;) {
      const token = this.exprPeek(st);
      if (token.kind === 'op' && (token.text === '++' || token.text === '--') && PREC_POSTFIX >= minPrecedence) {
        this.exprNext(st);
        left = this.frame('postfix_expression', left.start, token.end, [
          left,
          this.anon(token.text, token.start, token.end),
        ]);
        continue;
      }
      if (token.kind === 'op' && token.text === '?' && PREC_TERNARY >= minPrecedence) {
        this.exprNext(st);
        st.expectOperator = false;
        const kids: Frame[] = [left, this.anon('?', token.start, token.end)];
        const consequence = this.parseExpression(st, 0);
        if (consequence === null) this.hasError = true;
        else kids.push(consequence);
        const colon = this.exprPeek(st);
        if (colon.kind === 'op' && colon.text === ':') {
          this.exprNext(st);
          st.expectOperator = false;
          kids.push(this.anon(':', colon.start, colon.end));
        } else {
          this.hasError = true; // missing : in ternary
        }
        const alternative = this.parseExpression(st, PREC_TERNARY + 1);
        if (alternative === null) this.hasError = true;
        else kids.push(alternative);
        left = this.frame('ternary_expression', left.start, this.endOf(kids, token.end), kids);
        st.expectOperator = true;
        continue;
      }
      const isTestOp = token.kind === 'testop';
      const precedence = isTestOp ? PREC_TEST : token.kind === 'op' ? EXPRESSION_PRECEDENCE[token.text] : undefined;
      if (precedence === undefined || precedence < minPrecedence) break;
      this.exprNext(st);
      st.expectOperator = false;
      // `=~` in a test command takes a raw regex (or string/expansion) as
      // its right side instead of a full expression.
      if (st.mode === 'test' && token.kind === 'op' && token.text === '=~') {
        const right = this.parseTestRegex(st);
        const kids: Frame[] = [left, this.anon('=~', token.start, token.end)];
        if (right === null) this.hasError = true;
        else kids.push(right);
        left = this.frame('binary_expression', left.start, this.endOf(kids, token.end), kids);
        st.expectOperator = true;
        continue;
      }
      const rightPrecedence = token.text === '**' && st.mode === 'test' ? precedence : precedence + 1;
      let right: Frame | null;
      // An extglob group pattern after ==/!= is one extglob_pattern node
      // (`[[ $a == +(!a) ]]` in the reference).
      if (st.mode === 'test' && (token.text === '==' || token.text === '!=')) {
        right = this.tryParseExtglobGroup(st);
        if (right !== null) {
          const kids: Frame[] = [left, this.anon(token.text, token.start, token.end), right];
          left = this.frame('binary_expression', left.start, right.end, kids);
          st.expectOperator = true;
          continue;
        }
      }
      right = this.parseExpression(st, rightPrecedence);
      if (right === null) {
        this.hasError = true; // missing right operand
      } else if (st.mode === 'test' && token.kind === 'op') {
        right = this.convertTestRightSide(token.text, right, st);
      }
      const operator =
        token.kind === 'testop'
          ? this.frame('test_operator', token.start, token.end)
          : this.anon(token.text, token.start, token.end);
      const kids: Frame[] = right === null ? [left, operator] : [left, operator, right];
      left = this.frame('binary_expression', left.start, this.endOf(kids, token.end), kids);
      st.expectOperator = true;
    }
    return left;
  }

  private parseExprPrimary(st: ExprState): Frame | null {
    const token = this.exprPeek(st);
    switch (token.kind) {
      case 'end':
      case 'rparen':
        return null;
      case 'number':
        this.exprNext(st);
        return this.frame('number', token.start, token.end);
      case 'ident': {
        this.exprNext(st);
        if (st.mode === 'c') {
          // `name = value` in a c-style for header is a variable_assignment
          // (all other assignment operators are binary_expressions).
          const next = this.exprPeek(st);
          if (next.kind === 'op' && next.text === '=') {
            this.exprNext(st);
            const kids: Frame[] = [
              this.frame('variable_name', token.start, token.end),
              this.anon('=', next.start, next.end),
            ];
            const value = this.parseExpression(st, 0);
            if (value === null) this.hasError = true;
            else kids.push(value);
            return this.frame('variable_assignment', token.start, this.endOf(kids, next.end), kids);
          }
          return this.frame('word', token.start, token.end);
        }
        return this.frame('variable_name', token.start, token.end);
      }
      case 'word': {
        this.exprNext(st);
        // In a test command a `-digits` operand is unary minus, not a
        // number literal (`[[ $a == -1 ]]` → unary(-, number 1) — the
        // opposite of the max-length rule in ${v: -1}).
        if (st.mode === 'test' && /^-\d+$/.test(token.text)) {
          return this.frame('unary_expression', token.start, token.end, [
            this.anon('-', token.start, token.start + 1),
            this.frame('number', token.start + 1, token.end),
          ]);
        }
        return this.parseLiteral(token.start, token.end);
      }
      case 'subst':
      case 'string':
        this.exprNext(st);
        return token.frame!;
      case 'lparen': {
        this.exprNext(st);
        if (this.exprDepth >= MAX_PARSE_DEPTH) {
          this.hasError = true;
          st.pos = st.end;
          st.lookahead = null;
          return this.frame('ERROR', token.start, st.end);
        }
        this.exprDepth++;
        st.parenDepth++;
        const kids: Frame[] = [this.anon('(', token.start, token.end)];
        const inner = this.parseExpression(st, 0);
        if (inner !== null) kids.push(inner);
        if (st.mode === 'c') {
          // _c_parenthesized_expression: comma-separated expressions.
          for (;;) {
            const comma = this.exprPeek(st);
            if (comma.kind !== 'op' || comma.text !== ',') break;
            this.exprNext(st);
            kids.push(this.anon(',', comma.start, comma.end));
            const next = this.parseExpression(st, 0);
            if (next === null) {
              this.hasError = true;
              break;
            }
            kids.push(next);
          }
        }
        let end = this.endOf(kids, token.end);
        const close = this.exprPeek(st);
        if (close.kind === 'rparen') {
          this.exprNext(st);
          kids.push(this.anon(')', close.start, close.end));
          end = close.end;
        } else {
          this.hasError = true; // unterminated parenthesized expression
        }
        st.parenDepth--;
        this.exprDepth--;
        return this.frame('parenthesized_expression', token.start, end, kids);
      }
      case 'op':
      case 'testop':
      case 'unknown': {
        // An operator where an operand was expected: recover.
        this.exprNext(st);
        this.hasError = true;
        return this.frame('ERROR', token.start, token.end);
      }
    }
  }

  /** The right side of `=~` in a test command: a quoted string, an
   *  expansion, or a raw regex run (up to whitespace). */
  private parseTestRegex(st: ExprState): Frame | null {
    let i = st.pos;
    while (i < st.end && (this.source[i] === ' ' || this.source[i] === '\t' || this.source[i] === '\r')) i++;
    st.pos = i;
    st.lookahead = null;
    if (i >= st.end) return null;
    const ch = this.source[i]!;
    if (ch === '"') {
      const [piece, next] = this.parseString(i, st.end);
      st.pos = next;
      return piece;
    }
    if (ch === "'") {
      const close = skipSingleQuoted(this.source, this.budget, i, st.end);
      st.pos = close;
      return this.frame('raw_string', i, close);
    }
    if (ch === '$') {
      // An expansion holds the pattern: parse a normal operand.
      return this.parseExpression(st, PREC_TEST + 1);
    }
    let j = i;
    let sinceTick = 0;
    while (j < st.end) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const c = this.source[j]!;
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') break;
      if (c === '\\') {
        j += 2;
        continue;
      }
      j++;
    }
    st.pos = j;
    return this.frame('regex', i, j);
  }

  /** An extglob group pattern (`?(…)`, `*(…)`, `+(…)`, `@(…)`, `!(…)`)
   *  after `==`/`!=` in a test command: one raw extglob_pattern node over
   *  the operator and its balanced group. Null (no state touched) when the
   *  upcoming text is not a group. */
  private tryParseExtglobGroup(st: ExprState): Frame | null {
    let i = st.pos;
    while (i < st.end && (this.source[i] === ' ' || this.source[i] === '\t' || this.source[i] === '\r')) i++;
    const ch = this.source[i];
    if ((ch === '?' || ch === '*' || ch === '+' || ch === '@' || ch === '!') && this.source[i + 1] === '(') {
      const scan = this.scanBalanced(i + 1, st.end, '(', ')');
      if (!scan.balanced) return null;
      st.pos = scan.end;
      st.lookahead = null;
      return this.frame('extglob_pattern', i, scan.end);
    }
    return null;
  }

  /** Reference-shaped right-hand sides for test comparisons:
   *  - after `=`, a bare word is a regex when it contains a glob character
   *    or `=` — but only outside parentheses (`[[ a = b*c ]]` → regex,
   *    `[[ a = b=c ]]` → regex, `[[ ( $a = x* ) ]]` → word);
   *  - after `==`/`!=`, a bare word follows the scanner.c extglob_pattern
   *    rule — see isTestExtglob.
   *  The right side may arrive as a concatenation of word/number fragments
   *  (the lexer splits [ ] into their own pieces, so `[0-9]*` is not one
   *  word); bare fragment runs are judged — and converted — as a whole. */
  private convertTestRightSide(operator: string, right: Frame, st: ExprState): Frame {
    if (right.type !== 'word' && !(right.type === 'concatenation' && this.isBarePieces(right))) {
      return right;
    }
    const text = this.text(right.start, right.end);
    if (operator === '=' && st.parenDepth === 0 && /[*?[\]=]/.test(text)) {
      return this.frame('regex', right.start, right.end);
    }
    if ((operator === '==' || operator === '!=') && this.isTestExtglob(right)) {
      return this.frame('extglob_pattern', right.start, right.end);
    }
    return right;
  }

  /** True when a concatenation consists only of word/number fragments, so
   *  it can be treated as one bare word in test comparisons. */
  private isBarePieces(frame: Frame): boolean {
    return frame.children.every((child) => child.type === 'word' || child.type === 'number');
  }

  /**
   * The extglob_pattern scan rule from tree-sitter-bash's scanner.c
   * (the `extglob_pattern:` label), reduced to what a bare test word can
   * reach (test words never contain blanks, quotes, `$`, `|` or parens):
   *   - the first character must be a letter or one of `?*+@!-)\.[`;
   *   - a leading `-letter` is just a word (`[[ $a == -foo ]]` → word);
   *   - a single character becomes a glob only when directly followed by
   *     whitespace (`[[ $a == b ]]` → glob, `[[ (a == b) ]]` → word);
   *   - a `-letters` second run followed by `)`, `\` or `.` stays a word;
   *   - otherwise the second character must be alphanumeric or one of
   *     `[?/\_*` (skipped when the word starts with `[`), and the word is
   *     a glob iff any character is neither a letter nor `.` — escapes
   *     count only the character after the backslash when it is not a
   *     space/quote (`foo\ bar` → word, `b\*c` → glob).
   */
  private isTestExtglob(right: Frame): boolean {
    const text = this.text(right.start, right.end);
    const nextChar = this.source[right.end];
    const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\r';
    const isAlpha = (ch: string): boolean => /[A-Za-z]/.test(ch);
    const isAlnum = (ch: string): boolean => /[A-Za-z0-9]/.test(ch);
    const c0 = text[0]!;
    if (!isAlpha(c0) && !'?*+@!-)\\.['.includes(c0)) return false;
    let sawNonAlphaDot = !isAlpha(c0);
    let i = 1;
    if (i >= text.length) {
      if (isSpace(nextChar) || nextChar === '|') return true;
      if ((c0 === ')' || c0 === '*') && nextChar === ')' && isSpace(this.source[right.end + 1])) {
        return sawNonAlphaDot;
      }
      return false;
    }
    // "-\w" is just a word after ==/!= in the reference.
    if (c0 === '-' && isAlpha(text[i]!)) return false;
    if (text[i] === '-') {
      // "-\w" in second position: just a word, unless something special
      // follows the run.
      i++;
      while (i < text.length && isAlnum(text[i]!)) i++;
      const after = i < text.length ? text[i]! : nextChar;
      if (after === ')' || after === '\\' || after === '.') return false;
      if (i >= text.length) return true;
    }
    // The second-character check is skipped for a leading `[` (the scanner
    // does not advance past it before checking).
    if (c0 !== '[' && !isAlnum(text[i]!) && !'[?/\\_*'.includes(text[i]!)) return false;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '\\') {
        // A backslash never counts itself; an escaped space/quote is
        // consumed silently (anything else is judged on its own).
        const after = text[i + 1];
        if (after === ' ' || after === '\t' || after === '\r' || after === '"') i++;
        continue;
      }
      if (!isAlpha(ch) && ch !== '.') sawNonAlphaDot = true;
    }
    return sawNonAlphaDot;
  }

  /** Character-level tokenizer for the expression engine over [st.pos,
   *  st.end). Produces one token per call and advances st.pos. */
  private scanExprToken(st: ExprState): ExprToken {
    const end = st.end;
    let i = st.pos;
    let sinceTick = 0;
    for (;;) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      if (i >= end) break;
      const ch = this.source[i]!;
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        i++;
        continue;
      }
      if (ch === '\\' && this.source[i + 1] === '\n') {
        i += 2; // line continuation
        continue;
      }
      break;
    }
    st.pos = i;
    if (i >= end) return { kind: 'end', start: i, end: i, text: '' };
    const ch = this.source[i]!;
    if (st.mode === 'test') return this.scanTestToken(st, i, ch);

    // Arithmetic / c-style-for tokens.
    if (ch >= '0' && ch <= '9') {
      let j = i;
      if (ch === '0' && (this.source[i + 1] === 'x' || this.source[i + 1] === 'X')) {
        j = i + 2;
        while (j < end && /[0-9a-fA-F]/.test(this.source[j]!)) j++;
      } else {
        while (j < end && this.source[j]! >= '0' && this.source[j]! <= '9') j++;
        if (this.source[j] === '#') {
          j++;
          while (j < end && /[0-9A-Za-z@_]/.test(this.source[j]!)) j++;
        }
      }
      st.pos = j;
      return { kind: 'number', start: i, end: j, text: this.text(i, j) };
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < end && /\w/.test(this.source[j]!)) j++;
      if (this.source[j] === '[' && j < end) {
        // Subscript: name[index] — the index is a literal.
        const sub = this.scanBalanced(j, end, '[', ']');
        if (!sub.balanced) this.hasError = true;
        const indexEnd = sub.balanced ? sub.end - 1 : sub.end;
        const kids: Frame[] = [this.frame('variable_name', i, j), this.anon('[', j, j + 1)];
        if (indexEnd > j + 1) {
          kids.push(this.parseLiteral(j + 1, indexEnd));
        } else {
          this.hasError = true; // empty subscript index
        }
        if (sub.balanced) kids.push(this.anon(']', sub.end - 1, sub.end));
        st.pos = sub.end;
        return { kind: 'subst', start: i, end: sub.end, text: this.text(i, sub.end), frame: this.frame('subscript', i, sub.end, kids) };
      }
      st.pos = j;
      return { kind: 'ident', start: i, end: j, text: this.text(i, j) };
    }
    if (ch === '$') {
      const dollar = this.parseDollar(i, end);
      if (dollar !== null) {
        st.pos = dollar[1];
        return { kind: 'subst', start: i, end: dollar[1], text: this.text(i, dollar[1]), frame: dollar[0] };
      }
      this.hasError = true; // bare $ inside arithmetic
      st.pos = i + 1;
      return { kind: 'subst', start: i, end: i + 1, text: '$', frame: this.frame('ERROR', i, i + 1) };
    }
    if (ch === '"') {
      const [piece, next] = this.parseString(i, end);
      st.pos = next;
      return { kind: 'string', start: i, end: next, text: this.text(i, next), frame: piece };
    }
    if (ch === '`') {
      const [piece, next] = this.parseBacktickSubstitution(i, end);
      st.pos = next;
      return { kind: 'subst', start: i, end: next, text: this.text(i, next), frame: piece };
    }
    if (ch === '(') {
      st.pos = i + 1;
      return { kind: 'lparen', start: i, end: i + 1, text: '(' };
    }
    if (ch === ')') {
      st.pos = i + 1;
      return { kind: 'rparen', start: i, end: i + 1, text: ')' };
    }
    for (const operator of EXPRESSION_OPERATORS) {
      if (i + operator.length <= end && this.source.startsWith(operator, i)) {
        st.pos = i + operator.length;
        return { kind: 'op', start: i, end: st.pos, text: operator };
      }
    }
    // Unknown character: recover one char at a time.
    st.pos = i + 1;
    return { kind: 'unknown', start: i, end: i + 1, text: ch };
  }

  /** Tokenizer for test-command expressions ([[ … ]] / [ … ]). Words stop
   *  at whitespace and ( ) < > & | only — `=` and `!` are word characters
   *  unless they start a token (`a=b` is one word in the reference, while
   *  spaced `=`/`==`/`!=`/`=~` are operators). */
  private scanTestToken(st: ExprState, i: number, ch: string): ExprToken {
    const end = st.end;
    if (ch === '(') {
      // `((…))` inside a test is an arithmetic_expansion when the balanced
      // region closes with `))` (`[[ ((a)) == x ]]` in the reference);
      // otherwise the parens nest as parenthesized_expressions.
      if (this.source[i + 1] === '(') {
        const scan = this.scanBalanced(i, end, '(', ')');
        if (scan.balanced && scan.end - 2 > i + 1 && this.source[scan.end - 2] === ')') {
          const [piece, next] = this.parseParenArithmetic(i, end);
          st.pos = next;
          return { kind: 'subst', start: i, end: next, text: this.text(i, next), frame: piece };
        }
      }
      st.pos = i + 1;
      return { kind: 'lparen', start: i, end: i + 1, text: '(' };
    }
    if (ch === ')') {
      st.pos = i + 1;
      return { kind: 'rparen', start: i, end: i + 1, text: ')' };
    }
    if (ch === '&' && this.source[i + 1] === '&') {
      st.pos = i + 2;
      return { kind: 'op', start: i, end: i + 2, text: '&&' };
    }
    if (ch === '|' && this.source[i + 1] === '|') {
      st.pos = i + 2;
      return { kind: 'op', start: i, end: i + 2, text: '||' };
    }
    if (ch === '<' || ch === '>') {
      const wide = this.source[i + 1] === '=' ? 2 : 1;
      st.pos = i + wide;
      return { kind: 'op', start: i, end: i + wide, text: this.text(i, i + wide) };
    }
    if (ch === '!' || ch === '=') {
      if (st.expectOperator) {
        // After an operand these are comparison operators even when the
        // next word is attached (`=~^x`, `==b`, `=b` all split).
        const two = this.source.slice(i, i + 2);
        const wide = two === '==' || two === '=~' || two === '!=' ? 2 : 1;
        st.pos = i + wide;
        return { kind: 'op', start: i, end: i + wide, text: this.text(i, i + wide) };
      }
      // At operand position only a standalone `!` is the prefix operator;
      // everything else (=b, !x, !=b) is word material in the reference.
      const after = this.source[i + 1];
      if (ch === '!' && (after === undefined || after === ' ' || after === '\t' || after === '\r' || i + 1 >= end)) {
        st.pos = i + 1;
        return { kind: 'op', start: i, end: i + 1, text: '!' };
      }
      // Fall through to the word region below.
    }
    if (ch === '-' && /[A-Za-z]/.test(this.source[i + 1] ?? '')) {
      // test_operator: -letters followed by whitespace AND by a real
      // operand (scanner.c's rule: -\w followed by an operator, the closer
      // or nothing is just a word — `[[ -foo == x ]]`, `[[ $a == -foo ]]`,
      // `[[ -f ]]` all keep `-foo`/`-f` as words in the reference).
      let j = i + 1;
      while (j < end && /[A-Za-z]/.test(this.source[j]!)) j++;
      const after = this.source[j];
      if (j < end && (after === ' ' || after === '\t' || after === '\r')) {
        let k = j;
        while (k < end && (this.source[k] === ' ' || this.source[k] === '\t' || this.source[k] === '\r')) k++;
        const next = this.source[k];
        if (k < end && next !== '=' && next !== ']' && next !== '&' && next !== '|' && next !== ')') {
          st.pos = j;
          return { kind: 'testop', start: i, end: j, text: this.text(i, j) };
        }
      }
    }
    // A word region: quote- and substitution-aware, stopping at blanks and
    // the operator characters above.
    let j = i;
    let sinceTick = 0;
    while (j < end) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const c = this.source[j]!;
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') break;
      if (c === '(' || c === ')' || c === '<' || c === '>' || c === '&' || c === '|') break;
      if (c === '"') {
        j = skipDoubleQuoted(this.source, this.budget, j, end);
        continue;
      }
      if (c === "'") {
        j = skipSingleQuoted(this.source, this.budget, j, end);
        continue;
      }
      if (c === '`') {
        j = skipBacktick(this.source, this.budget, j, end);
        continue;
      }
      if (c === '$') {
        j = this.skipDollarConstruct(j, end);
        continue;
      }
      if (c === '\\') {
        j += 2;
        continue;
      }
      j++;
    }
    if (j === i) j++; // defensive: never stall
    st.pos = j;
    // A lone arithmetic operator character is an operator, not a word.
    if (j === i + 1 && (ch === '+' || ch === '*' || ch === '/' || ch === '%')) {
      return { kind: 'op', start: i, end: j, text: ch };
    }
    return { kind: 'word', start: i, end: j, text: this.text(i, j) };
  }

  // ------------------------------------------------------------ test command

  /**
   * test_command in the `(( expression ))` form — only reached for
   * statement-position `((word++…))` / `((word--…))` (see PAREN_TEST_RE);
   * every other `((…))` is an arithmetic_expansion. The header arrived as
   * one word token (see the lexer), so no repositioning is needed.
   */
  private parseParenTestCommand(): Frame {
    const token = this.lexer.next();
    const closed =
      token.end - token.start >= 4 && this.source[token.end - 2] === ')' && this.source[token.end - 1] === ')';
    if (!closed) this.hasError = true;
    const kids: Frame[] = [this.anon('((', token.start, token.start + 2)];
    const innerEnd = closed ? token.end - 2 : token.end;
    if (innerEnd > token.start + 2) {
      const st = this.newExprState(token.start + 2, innerEnd, 'test');
      const expression = this.parseExpression(st, 0);
      if (expression !== null) kids.push(expression);
      const leftover = this.exprLeftover(st);
      if (leftover !== null) kids.push(leftover);
    }
    if (closed) {
      kids.push(this.anon('))', token.end - 2, token.end));
    }
    return this.frame('test_command', token.start, this.endOf(kids, token.end), kids);
  }

  /**
   * test_command: `[[ expression ]]` or `[ expression ]`. The peeked token
   * is the single-character word `[`; `[[` is detected by the adjacent
   * second `[` in the source. The expression range is scanned
   * character-wise (quote/substitution aware) up to the closer or the end
   * of the line, parsed by the expression engine in test mode, and the main
   * lexer is then repositioned past the closer.
   */
  private parseTestCommand(): Frame {
    const openToken = this.lexer.next();
    const double = this.source[openToken.end] === '[';
    const opener = double ? '[[' : '[';
    const closer = double ? ']]' : ']';
    const exprStart = openToken.end + (double ? 1 : 0);
    const kids: Frame[] = [this.anon(opener, openToken.start, exprStart)];
    const scan = this.scanTestCloser(exprStart, double);
    if (scan.closerStart > exprStart) {
      const st = this.newExprState(exprStart, scan.closerStart, 'test');
      const expression = this.parseExpression(st, 0);
      if (expression !== null) kids.push(expression);
      const leftover = this.exprLeftover(st);
      if (leftover !== null) kids.push(leftover);
    }
    let end = scan.closerStart;
    if (scan.found) {
      if (double && kids.length === 1) {
        // `[[ ]]` (empty expression): the reference parses the closer text
        // as two word pieces inside a concatenation and inserts a
        // zero-width `]]` after them.
        this.hasError = true;
        kids.push(
          this.frame('concatenation', scan.closerStart, scan.afterCloser, [
            this.frame('word', scan.closerStart, scan.closerStart + 1),
            this.frame('word', scan.closerStart + 1, scan.afterCloser),
          ]),
        );
        kids.push(this.anon(closer, scan.afterCloser, scan.afterCloser));
      } else {
        kids.push(this.anon(closer, scan.closerStart, scan.afterCloser));
      }
      end = scan.afterCloser;
    } else {
      // Unterminated: keep a zero-width closer and flag the error (our
      // documented recovery policy); trailing blanks stay outside the node,
      // as in the reference. The reference inserts a zero-width closer only
      // for an unterminated `[` or for `[[` ending in a complete unary
      // test — other unterminated `[[` forms become an ERROR node there.
      this.hasError = true;
      let closeAt = scan.closerStart;
      while (closeAt > exprStart && (this.source[closeAt - 1] === ' ' || this.source[closeAt - 1] === '\t' || this.source[closeAt - 1] === '\r')) {
        closeAt--;
      }
      kids.push(this.anon(closer, closeAt, closeAt));
      end = closeAt;
    }
    this.lexer.reposition(end);
    return this.frame('test_command', openToken.start, end, kids);
  }

  /** Find the closer of a test command, skipping quotes and substitutions.
   *  Bounded by the end of the line and the lexer's range. */
  private scanTestCloser(start: number, double: boolean): { closerStart: number; afterCloser: number; found: boolean } {
    const end = this.lexer.rangeEnd;
    let j = start;
    let sinceTick = 0;
    while (j < end) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const ch = this.source[j]!;
      if (ch === '\n') break;
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '"') {
        j = skipDoubleQuoted(this.source, this.budget, j, end);
        continue;
      }
      if (ch === "'") {
        j = skipSingleQuoted(this.source, this.budget, j, end);
        continue;
      }
      if (ch === '`') {
        j = skipBacktick(this.source, this.budget, j, end);
        continue;
      }
      if (ch === '$') {
        j = this.skipDollarConstruct(j, end);
        continue;
      }
      if ((ch === '<' || ch === '>') && this.source[j + 1] === '(') {
        j = this.scanBalanced(j + 1, end, '(', ')').end;
        continue;
      }
      if (ch === ']') {
        if (double) {
          if (this.source[j + 1] === ']') return { closerStart: j, afterCloser: j + 2, found: true };
        } else {
          return { closerStart: j, afterCloser: j + 1, found: true };
        }
      }
      j++;
    }
    return { closerStart: j, afterCloser: j, found: false };
  }

  /** heredoc_body content: heredoc_content chunks interleaved with
   *  expansions and command substitutions (unquoted delimiters only).
   *  Unlike tree-sitter-bash's scanner, every plain chunk — including the
   *  leading one — becomes a heredoc_content node. */
  private parseHeredocContent(start: number, end: number): Frame[] {
    const pieces: Frame[] = [];
    let chunkStart = start;
    let i = start;
    const flush = (upto: number): void => {
      if (upto > chunkStart) {
        pieces.push(this.frame('heredoc_content', chunkStart, upto));
      }
    };
    let sinceTick = 0;
    while (i < end) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const ch = this.source[i]!;
      if (ch === '\\') {
        i += 2; // escaped characters stay literal (and suppress expansion)
        continue;
      }
      if (ch === '$') {
        const dollar = this.parseDollar(i, end);
        if (dollar !== null) {
          flush(i);
          pieces.push(dollar[0]);
          i = dollar[1];
          chunkStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (ch === '`') {
        flush(i);
        const [piece, next] = this.parseBacktickSubstitution(i, end);
        pieces.push(piece);
        i = next;
        chunkStart = i;
        continue;
      }
      i++;
    }
    flush(end);
    return pieces;
  }

  /** Balanced-scan wrapper returning whether the close was actually found. */
  private scanBalanced(i: number, end: number, open: string, close: string): BalancedScan {
    return scanBalanced(this.source, this.budget, i, end, open, close);
  }
}

/**
 * Convert a finished frame tree into SyntaxNodeBuilders. Iterative
 * (explicit stack) so deep trees cannot overflow the call stack; node
 * creation here is not budget-ticked because every frame already ticked the
 * budget when it was created (one frame ↔ one node).
 */
export function materialize(root: Frame, source: string): SyntaxNodeBuilder {
  const nodes = new Map<Frame, SyntaxNodeBuilder>();
  const order: Frame[] = [];
  const stack: Frame[] = [root];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    order.push(frame);
    for (const child of frame.children) stack.push(child);
  }
  for (const frame of order) {
    nodes.set(
      frame,
      new SyntaxNodeBuilder({
        type: frame.type,
        source,
        startIndex: frame.start,
        endIndex: frame.end,
        isNamed: frame.isNamed,
      }),
    );
  }
  for (const frame of order) {
    const node = nodes.get(frame)!;
    for (const child of frame.children) {
      node.addChild(nodes.get(child)!);
    }
  }
  return nodes.get(root)!;
}

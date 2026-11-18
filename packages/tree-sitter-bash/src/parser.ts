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
import { Lexer, scanBalanced, scanBalancedStatements, skipBacktick, skipDollar, skipDoubleQuoted, skipSingleQuoted } from '#/lexer';
import type { BalancedScan, HeredocBody, HeredocSpec, Token } from '#/lexer';
import { SyntaxNodeBuilder } from '#/node';

export const MAX_PARSE_DEPTH = 500;

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
const FUNCTION_NAME_RE = /^[A-Za-z_][\w:]*$/;
const BRACE_EXPRESSION_RE = /^\{(\d+)\.\.(\d+)\}/;
const PAREN_TEST_RE = /^\(\(\s*[A-Za-z_][\w-]*(\+\+|--)/;
const STOP_THEN: ReadonlySet<string> = new Set(['then']);
const STOP_DO: ReadonlySet<string> = new Set(['do']);
const STOP_DONE: ReadonlySet<string> = new Set(['done']);
const STOP_IF_BODY: ReadonlySet<string> = new Set(['elif', 'else', 'fi']);
const STOP_FI: ReadonlySet<string> = new Set(['fi']);
const STOP_CLOSE_BRACE: ReadonlySet<string> = new Set(['}']);
const STOP_ESAC: ReadonlySet<string> = new Set(['esac']);
const CASE_TERMINATION_OPS: ReadonlySet<string> = new Set([';;', ';&', ';;&']);

const SCAN_TICK_INTERVAL = 2048;

const PREC_TERNARY = 2;
const PREC_TEST = 10;
const PREC_UNARY = 11;
const PREC_PREFIX = 17;
const PREC_POSTFIX = 18;

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
  readonly terminatorRequired?: boolean;
}

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
  readonly frame?: Frame;
}

interface ExprState {
  pos: number;
  readonly end: number;
  readonly mode: ExprMode;
  lookahead: ExprToken | null;
  parenDepth: number;
  expectOperator: boolean;
}

function isFileRedirectOp(text: string): boolean {
  return FILE_REDIRECT_OP_SET.has(text);
}

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
  hasError = false;
  private lexer!: Lexer;
  private readonly heredocQueue: PendingHeredoc[] = [];
  private scopeDepth = 0;
  private literalDepth = 0;
  private exprDepth = 0;
  private noHeredoc = false;
  private caseItemDepth = 0;
  private lastTerminatorEnd = 0;

  constructor(
    private readonly source: string,
    private readonly budget: ParseBudget,
    private readonly depth = 0,
  ) {}

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

  private peekKeyword(keyword: string): boolean {
    const token = this.lexer.peek();
    return token.type === 'word' && this.tokenText(token) === keyword;
  }

  private consumeKeyword(kids: Frame[], keyword: string): boolean {
    if (!this.peekKeyword(keyword)) return false;
    const token = this.lexer.next();
    kids.push(this.anon(keyword, token.start, token.end));
    return true;
  }

  parseProgram(): Frame {
    this.lexer = new Lexer(this.source, this.budget, 0, this.source.length);
    const children = this.parseStatementList();
    return this.frame('program', 0, this.source.length, children);
  }

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
        if (needTerminator && options.terminatorRequired === true) this.hasError = true;
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
        this.hasError = true;
        this.lexer.next();
        children.push(this.frame('ERROR', token.start, token.end, [this.anon(op, token.start, token.end)]));
        needTerminator = false;
        continue;
      }
      if (needTerminator) this.hasError = true;
      children.push(this.parseList());
      needTerminator = true;
    }
    return children;
  }

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
        this.hasError = true;
        left = this.frame('list', left.start, token.end, [left, this.anon(op, token.start, token.end)]);
        break;
      }
    }
    return left;
  }

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
        this.hasError = true;
        break;
      }
    }
    if (pipes === 0) return first;
    return this.frame('pipeline', first.start, end, kids);
  }

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
      this.hasError = true;
      const skipped = this.lexer.next();
      inner = this.frame('ERROR', skipped.start, skipped.end);
    }
    return inner;
  }

  private parseStatementCore(): Frame | null {
    const token = this.lexer.peek();
    if (token.type === 'op' && this.tokenText(token) === '(') {
      return this.parseSubshell();
    }
    if (token.type === 'word') {
      const text = this.tokenText(token);
      if (text === '!') return this.parseNegatedCommand();
      if (text === '{') {
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

  private parseSubshell(): Frame {
    const open = this.lexer.next();
    if (this.scopeDepth >= MAX_PARSE_DEPTH) {
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
    if (inner.length === 0) this.hasError = true;
    kids.push(...inner);
    let end = this.endOf(inner, open.end);
    const token = this.lexer.peek();
    if (token.type === 'op' && this.tokenText(token) === ')') {
      this.lexer.next();
      kids.push(this.anon(')', token.start, token.end));
      end = token.end;
    } else {
      this.hasError = true;
    }
    return this.frame('subshell', open.start, end, kids);
  }

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
      this.hasError = true;
    }
    return this.frame('compound_statement', open.start, end, kids);
  }

  private parseIfStatement(): Frame {
    const ifToken = this.lexer.next();
    const kids: Frame[] = [
      this.anon('if', ifToken.start, ifToken.end),
      ...this.parseStatementList({ stopWords: STOP_THEN, terminatorRequired: true }),
    ];
    if (!this.consumeKeyword(kids, 'then')) {
      this.hasError = true;
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
      this.hasError = true;
    }
    return this.frame('if_statement', ifToken.start, end, kids);
  }

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
    const end = Math.max(this.endOf(kids, elifToken.end), this.lastTerminatorEnd);
    return this.frame('elif_clause', elifToken.start, end, kids);
  }

  private parseElseClause(): Frame {
    const elseToken = this.lexer.next();
    const kids: Frame[] = [
      this.anon('else', elseToken.start, elseToken.end),
      ...this.parseStatementList({ stopWords: STOP_FI, terminatorRequired: true }),
    ];
    const end = Math.max(this.endOf(kids, elseToken.end), this.lastTerminatorEnd);
    return this.frame('else_clause', elseToken.start, end, kids);
  }

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
      this.hasError = true;
    }
    return this.frame('while_statement', kwToken.start, this.endOf(kids, kwToken.end), kids);
  }

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
      this.hasError = true;
    }
    return this.frame('do_group', doToken.start, end, kids);
  }

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
      this.hasError = true;
    }
    if (this.peekKeyword('in')) {
      const inToken = this.lexer.next();
      const values: Frame[] = [];
      while (this.lexer.peek().type === 'word') {
        values.push(this.parseWordArgument());
      }
      if (values.length === 0) {
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
      this.hasError = true;
    }
    return this.frame('for_statement', kwToken.start, this.endOf(kids, kwToken.end), kids);
  }

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
      this.hasError = true;
    }
    return this.frame('c_style_for_statement', kwToken.start, this.endOf(kids, kwToken.end), kids);
  }

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
          this.hasError = true;
          break;
        }
      }
    }
    const leftover = this.exprLeftover(st);
    if (leftover !== null) kids.push(leftover);
    return kids;
  }

  private parseCaseStatement(): Frame {
    const caseToken = this.lexer.next();
    const kids: Frame[] = [this.anon('case', caseToken.start, caseToken.end)];
    if (this.lexer.peek().type === 'word') {
      kids.push(this.parseWordArgument());
    } else {
      this.hasError = true;
    }
    this.skipCaseTerminators(kids);
    if (!this.consumeKeyword(kids, 'in')) {
      this.hasError = true;
      return this.frame('case_statement', caseToken.start, this.endOf(kids, caseToken.end), kids);
    }
    this.skipCaseTerminators(kids);
    for (;;) {
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
        this.hasError = true;
        break;
      }
      if (token.type === 'word' && this.tokenText(token) === 'esac') break;
      const before = this.lexer.pos;
      kids.push(this.parseCaseItem());
      if (this.lexer.pos === before) {
        this.hasError = true;
        this.lexer.next();
      }
      if (this.peekKeyword('esac')) {
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

  private parseCaseItem(): Frame {
    const kids: Frame[] = [];
    let token = this.lexer.peek();
    if (token.type === 'op' && this.tokenText(token) === '(') {
      this.lexer.next();
      kids.push(this.anon('(', token.start, token.end));
    }
    let firstAlternative = true;
    for (;;) {
      token = this.lexer.peek();
      if (token.type !== 'word') {
        this.hasError = true;
        break;
      }
      const alt = this.scanCasePatternEnd(token.start);
      kids.push(...this.parseCasePattern(token.start, alt.end, firstAlternative));
      firstAlternative = false;
      this.lexer.reposition(alt.end);
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
      this.hasError = true;
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
    const end = Math.max(this.endOf(kids, token.start), this.lastTerminatorEnd);
    return this.frame('case_item', start, end, kids);
  }

  private scanCasePatternEnd(i: number): { end: number } {
    const end = this.lexer.rangeEnd;
    let depth = 0;
    let j = i;
    let sinceTick = 0;
    while (j < end) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const ch = this.source[j]!;
      if (ch === '\n' || ch === ';') break;
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
      if (ch === '(') {
        depth++;
        j++;
        continue;
      }
      if (ch === ')') {
        if (depth === 0) return { end: j };
        depth--;
        j++;
        continue;
      }
      if (ch === '|' && depth === 0) return { end: j };
      if ((ch === ' ' || ch === '\t' || ch === '\r') && depth === 0) return { end: j };
      j++;
    }
    return { end: j };
  }

  private parseCasePattern(start: number, end: number, allowBlob: boolean): Frame[] {
    const raw = this.text(start, end);
    const group = /[?*+@!.]\(/.exec(raw);
    if (group !== null) {
      if (this.extglobGroupAccepted(start, end)) return [this.frame('extglob_pattern', start, end)];
      this.hasError = true;
      return [this.frame('ERROR', start, end)];
    }
    if (!/["'$`]/.test(raw)) {
      if (this.isBareGlobPattern(start, end)) return [this.frame('extglob_pattern', start, end)];
      return [this.parseLiteral(start, end)];
    }
    if (allowBlob) {
      const pieces = this.parseExtglobBlob(start, end);
      if (pieces !== null) return pieces;
    }
    return [this.parseLiteral(start, end)];
  }

  private extglobGroupAccepted(start: number, end: number): boolean {
    const isAlpha = (ch: string): boolean => /[A-Za-z]/.test(ch);
    const isAlnum = (ch: string): boolean => /[A-Za-z0-9]/.test(ch);
    const c0 = this.source[start]!;
    if (!isAlpha(c0) && !'?*+@!-)\\.['.includes(c0)) return false;
    if (c0 === '[') return true;
    let check = start + 1;
    if (c0 === '\\') {
      const after = this.source[start + 1];
      if (after === undefined || !(after === ' ' || after === '\t' || after === '\r' || after === '"')) return false;
      check = start + 3;
    }
    if (check >= end) return false;
    const ch = this.source[check]!;
    return isAlnum(ch) || '([?/\\_*'.includes(ch);
  }

  private isBareGlobPattern(start: number, end: number): boolean {
    const raw = this.text(start, end);
    if (raw.includes('\\')) return false;
    if (NUMBER_RE.test(raw)) return false;
    const isAlpha = (ch: string): boolean => /^\p{L}$/u.test(ch);
    const isAlnum = (ch: string): boolean => /^[\p{L}\p{N}]$/u.test(ch);
    const next = this.source[end] ?? '';
    const c0 = raw[0]!;
    if (!isAlpha(c0) && !'?*+@!-)\\.['.includes(c0)) return false;
    if (c0 === '-') {
      if (raw.length > 1 && raw[1] === '-') return true;
      let innerDash = -1;
      for (let i = 1; i < raw.length; i++) {
        if (raw[i] === '-') {
          innerDash = i;
          break;
        }
      }
      if (innerDash === -1) return false;
      return raw[innerDash + 1] !== '-';
    }
    if (raw.length === 1) {
      if (next === ')') return !isAlpha(c0);
      if (next === '|' || next === ' ' || next === '\t' || next === '\r' || next === '\n' || next === '') return true;
    }
    if (raw.length > 1) {
      let p = 1;
      if (raw[1] === '-') {
        let i = 2;
        while (i < raw.length && isAlnum(raw[i]!)) i++;
        if (i >= raw.length) {
          if (next === ')') return false;
          return true;
        }
        const after = raw[i]!;
        if (after === '.' || after === '\\') return false;
        if (!isAlnum(after) && !'([?/\\_*'.includes(after)) return false;
        p = i;
      }
      if (c0 !== '[' && p === 1 && !isAlnum(raw[1]!) && !'([?/\\_*'.includes(raw[1]!)) return false;
    }
    if (next === '|') return true;
    if (!isAlpha(c0)) return true;
    for (let i = 1; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch !== '.' && !isAlpha(ch)) return true;
    }
    return false;
  }

  private parseExtglobBlob(start: number, end: number, leadValidator?: (s: number, e: number) => boolean): Frame[] | null {
    let i = start;
    while (i < end) {
      const ch = this.source[i]!;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`' || ch === '$') break;
      i++;
    }
    if (i >= end || i === start) return null;
    const leadText = this.text(start, i);
    const leadIsGlob =
      leadValidator !== undefined
        ? leadValidator(start, i)
        : leadText.includes('\\')
          ? /[*?[]/.test(leadText)
          : this.isBareGlobPattern(start, i);
    if (!leadIsGlob) return null;
    const lead = this.frame('extglob_pattern', start, i);
    let construct: Frame;
    let next: number;
    const ch = this.source[i]!;
    if (ch === '"') {
      [construct, next] = this.parseString(i, end);
    } else if (ch === "'") {
      next = skipSingleQuoted(this.source, this.budget, i, end);
      construct = this.frame('raw_string', i, next);
    } else if (ch === '`') {
      [construct, next] = this.parseBacktickSubstitution(i, end);
    } else {
      const dollar = this.parseDollar(i, end);
      if (dollar === null) return null;
      [construct, next] = dollar;
    }
    if (next >= end) return [lead, construct];
    const trail = this.frame('extglob_pattern', next, end);
    return [lead, construct, trail];
  }

  private parseCaseItemStatements(): Frame[] {
    this.caseItemDepth++;
    try {
      return this.parseStatementList({ stopWords: STOP_ESAC, stopOps: CASE_TERMINATION_OPS });
    } finally {
      this.caseItemDepth--;
    }
  }

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
        this.hasError = true;
      }
      this.consumeParenPair(kids);
    } else {
      kids.push(this.frame('word', first.start, first.end));
      this.consumeParenPair(kids);
    }
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
      this.hasError = true;
    }
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

  private isFunctionDefinitionAhead(): boolean {
    const name = this.lexer.peek();
    const text = this.tokenText(name);
    if (!FUNCTION_NAME_RE.test(text) || RESERVED_WORD_SET.has(text)) return false;
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
    const [nameStart, nameEnd] = this.consumeWordRun();
    const name = this.frame('command_name', nameStart, nameEnd, [this.parseLiteral(nameStart, nameEnd)]);
    const command = this.frame('command', start, nameEnd, [...prefix, name]);
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'word') {
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

  private parseCommandArgument(): Frame[] {
    const [start, end] = this.consumeWordRun();
    if (this.source[start] === '$' && this.source[start + 1] === '"' && start + 1 < end) {
      return [this.anon('$', start, start + 1), this.parseLiteral(start + 1, end)];
    }
    return [this.parseLiteral(start, end)];
  }

  private assembleNamelessPrefix(prefix: Frame[]): Frame {
    const assignments = prefix.filter((f) => f.type === 'variable_assignment');
    if (assignments.length === prefix.length) {
      if (prefix.length === 1) return prefix[0]!;
      return this.frame('variable_assignments', prefix[0]!.start, prefix.at(-1)!.end, prefix);
    }
    return this.frame('redirected_statement', prefix[0]!.start, prefix.at(-1)!.end, prefix);
  }

  private isSubscriptAssignmentAhead(token: Token): boolean {
    if (!IDENTIFIER_RE.test(this.tokenText(token))) return false;
    return SUBSCRIPT_ASSIGNMENT_RE.test(this.source.slice(token.start));
  }

  private parseSubscriptAssignment(): Frame {
    const start = this.lexer.peek().start;
    const match = SUBSCRIPT_ASSIGNMENT_RE.exec(this.source.slice(start))!;
    const nameEnd = start + match[1]!.length;
    const indexStart = nameEnd + 1;
    const indexEnd = indexStart + match[2]!.length;
    const opStart = indexEnd + 1;
    const opEnd = opStart + match[3]!.length;
    let valueEnd = opEnd;
    for (;;) {
      const token = this.lexer.peek();
      if (token.start >= opEnd) break;
      this.lexer.next();
      valueEnd = Math.max(valueEnd, token.end);
    }
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
      this.hasError = true;
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
      this.hasError = true;
      return this.frame('array', open.start, this.endOf(kids, open.end), kids);
    }
  }

  private parseRedirect(maxDestinations = Number.POSITIVE_INFINITY): Frame {
    let descriptor: Frame | null = null;
    let token = this.lexer.peek();
    if (token.type === 'io_number') {
      this.lexer.next();
      descriptor = this.frame('file_descriptor', token.start, token.end);
      token = this.lexer.peek();
    }
    if (token.type !== 'op') {
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

  private parseFileRedirect(descriptor: Frame | null, maxDestinations = Number.POSITIVE_INFINITY): Frame {
    const opToken = this.lexer.next();
    const op = this.tokenText(opToken);
    const kids: Frame[] = [];
    if (descriptor !== null) kids.push(descriptor);
    kids.push(this.anon(op, opToken.start, opToken.end));
    let end = opToken.end;
    if (op === '>&-' || op === '<&-') {
      if (this.lexer.peek().type === 'word') {
        const destination = this.parseWordArgument();
        kids.push(destination);
        end = destination.end;
      }
    } else {
      let destinations = 0;
      while (destinations < maxDestinations && this.lexer.peek().type === 'word') {
        const destination = this.parseWordArgument();
        kids.push(destination);
        end = destination.end;
        destinations++;
      }
      if (destinations === 0) this.hasError = true;
    }
    return this.frame('file_redirect', descriptor?.start ?? opToken.start, end, kids);
  }

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

  private parseHeredocRedirect(descriptor: Frame | null): Frame {
    const opToken = this.lexer.next();
    const op = this.tokenText(opToken);
    const kids: Frame[] = [];
    if (descriptor !== null) kids.push(descriptor);
    kids.push(this.anon(op, opToken.start, opToken.end));
    const redirect = this.frame('heredoc_redirect', descriptor?.start ?? opToken.start, opToken.end, kids);
    const startToken = this.lexer.peek();
    if (startToken.type !== 'word') {
      this.hasError = true;
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
        const broken = this.parseRedirect();
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
        this.hasError = true;
      }
      frame.end = end;
      for (let parent = frame.parent; parent !== null; parent = parent.parent) {
        if (parent.end < end) parent.end = end;
      }
    }
  }

  private failOpenHeredocs(): void {
    for (const pending of this.heredocQueue.splice(0)) {
      this.hasError = true;
      const at = pending.frame.end;
      this.addKid(pending.frame, this.frame('heredoc_body', at, at));
    }
  }

  private parseWordArgument(): Frame {
    const [start, end] = this.consumeWordRun();
    return this.parseLiteral(start, end);
  }

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
        if (close >= end && this.source[close - 1] !== "'") this.hasError = true;
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
      if (j === i) j++;
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

  private parseString(start: number, rangeEnd: number): [Frame, number] {
    const string = this.frame('string', start, start + 1, [this.anon('"', start, start + 1)]);
    let chunkStart = start + 1;
    let i = start + 1;
    const flushChunk = (upto: number): void => {
      if (upto > chunkStart) {
        this.addKid(string, this.frame('string_content', chunkStart, upto));
      }
    };
    const whitespaceOnlyChunk = (upto: number): boolean => {
      if (upto <= chunkStart) return false;
      return /^[ \t\r]+$/.test(this.source.slice(chunkStart, upto));
    };
    const absorbInto = (piece: Frame): boolean => {
      const first = piece.children[0];
      if (first === undefined) return false;
      piece.start = chunkStart;
      first.start = chunkStart;
      return true;
    };
    let sinceTick = 0;
    while (i < rangeEnd) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const ch = this.source[i]!;
      if (ch === '"') {
        const last = string.children.at(-1);
        if (whitespaceOnlyChunk(i) && last !== undefined && last.isNamed && last.type !== 'string_content') {
          this.addKid(string, this.anon('"', chunkStart, i + 1));
        } else {
          flushChunk(i);
          this.addKid(string, this.anon('"', i, i + 1));
        }
        string.end = i + 1;
        return [string, i + 1];
      }
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '$') {
        const dollar = this.parseDollar(i, rangeEnd);
        if (dollar !== null) {
          if (!(whitespaceOnlyChunk(i) && absorbInto(dollar[0]))) {
            flushChunk(i);
          }
          this.addKid(string, dollar[0]);
          i = dollar[1];
          chunkStart = i;
          continue;
        }
        flushChunk(i);
        this.addKid(string, this.anon('$', i, i + 1));
        i++;
        chunkStart = i;
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
    this.hasError = true;
    flushChunk(rangeEnd);
    string.end = rangeEnd;
    return [string, rangeEnd];
  }

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
    this.hasError = true;
    return [this.frame('ansi_c_string', i, rangeEnd), rangeEnd];
  }

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

  private isArithmeticSubscriptIndex(start: number, end: number): boolean {
    if (this.source.startsWith('++', start) || this.source.startsWith('--', start)) return true;
    const isBlank = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\r';
    let i = start;
    while (i < end) {
      const ch = this.source[i]!;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        i++;
        continue;
      }
      if (ch === '$') {
        i = this.skipDollarConstruct(i, end);
        continue;
      }
      if (ch === '(') {
        i = this.scanBalanced(i, end, '(', ')').end;
        continue;
      }
      if (ch === '[') {
        i = this.scanBalanced(i, end, '[', ']').end;
        continue;
      }
      if ('+-*/%<>=!&|^~?,'.includes(ch) && (isBlank(this.source[i - 1]) || isBlank(this.source[i + 1]))) return true;
      i++;
    }
    return false;
  }

  private remapVariableNamesToWords(frame: Frame): void {
    if (frame.type === 'variable_name') frame.type = 'word';
    for (const child of frame.children) this.remapVariableNamesToWords(child);
  }

  private parseExpansionInner(i: number, rangeEnd: number): [Frame, number] {
    const scan = this.scanBalanced(i + 1, rangeEnd, '{', '}');
    const close = scan.end;
    const terminated = scan.balanced;
    if (!terminated) this.hasError = true;
    const innerEnd = terminated ? close - 1 : close;
    const expansion = this.frame('expansion', i, close, [this.anon('${', i, i + 2)]);
    let j = i + 2;
    let bangPrefix = false;
    while (j < innerEnd && (this.source[j] === '#' || this.source[j] === '!')) {
      const after = this.source[j + 1];
      if (after === undefined || j + 1 >= innerEnd || !/[\w@*#?$!-]/.test(after)) break;
      if (this.source[j] === '!') bangPrefix = true;
      this.addKid(expansion, this.anon(this.source[j]!, j, j + 1));
      j++;
    }
    let hasName = false;
    if (j < innerEnd && /[\w]/.test(this.source[j]!)) {
      let nameEnd = j;
      while (nameEnd < innerEnd && /[\w]/.test(this.source[nameEnd]!)) nameEnd++;
      const special = nameEnd === j + 1 && this.source[j] === '0';
      this.addKid(expansion, this.frame(special ? 'special_variable_name' : 'variable_name', j, nameEnd));
      j = nameEnd;
      hasName = true;
    } else if (j < innerEnd && (this.source[j] === '#' || this.source[j] === '!') && j + 1 === innerEnd) {
      this.addKid(expansion, this.anon(this.source[j]!, j, j + 1));
      j++;
    } else if (j < innerEnd && SPECIAL_VARIABLE_CHARS.includes(this.source[j]!)) {
      this.addKid(expansion, this.frame('special_variable_name', j, j + 1));
      j++;
      hasName = true;
    }
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
        const indexText = this.text(j + 1, indexEnd);
        if (indexText === '*' || indexText === '@') {
          this.addKid(subscript, this.parseLiteral(j + 1, indexEnd));
        } else if (this.isArithmeticSubscriptIndex(j + 1, indexEnd)) {
          const st = this.newExprState(j + 1, indexEnd, 'arith');
          const index = this.parseExpression(st, 0);
          if (index !== null) {
            this.remapVariableNamesToWords(index);
            this.addKid(subscript, index);
          }
          const leftover = this.exprLeftover(st);
          if (leftover !== null) this.addKid(subscript, leftover);
        } else {
          this.addKid(subscript, this.parseLiteral(j + 1, indexEnd));
        }
      } else {
        this.hasError = true;
      }
      if (sub.balanced) this.addKid(subscript, this.anon(']', subEnd - 1, subEnd));
      this.addKid(expansion, subscript);
      j = subEnd;
    }
    if (bangPrefix && j < innerEnd && (this.source[j] === '*' || this.source[j] === '@')) {
      this.addKid(expansion, this.anon(this.source[j]!, j, j + 1));
      j++;
    }
    if (j < innerEnd) {
      j = this.parseExpansionInfix(expansion, j, innerEnd);
    }
    if (terminated) this.addKid(expansion, this.anon('}', close - 1, close));
    return [expansion, close];
  }

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
          for (const piece of this.parseExpansionValue(pos, innerEnd)) this.addKid(expansion, piece);
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
      this.addKid(expansion, this.anon(':', j, j + 1));
      let pos = this.parseMaxLengthValue(expansion, j + 1, innerEnd);
      if (pos < innerEnd && this.source[pos] === ':') {
        this.addKid(expansion, this.anon(':', pos, pos + 1));
        pos = this.parseMaxLengthValue(expansion, pos + 1, innerEnd);
      }
      if (pos < innerEnd) {
        this.hasError = true;
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
          for (const piece of this.parseExpansionValue(pos, innerEnd)) this.addKid(expansion, piece);
        }
        return innerEnd;
      }
    }
    this.hasError = true;
    this.addKid(expansion, this.parseLiteral(j, innerEnd));
    return innerEnd;
  }

  private parseExpansionPattern(expansion: Frame, j: number, innerEnd: number, stop?: string): number {
    let pos = j;
    while (pos < innerEnd && (this.source[pos] === ' ' || this.source[pos] === '\t' || this.source[pos] === '\r')) {
      pos++;
    }
    if (pos > j && (pos >= innerEnd || (stop !== undefined && this.source[pos] === stop))) {
      this.addKid(expansion, this.frame('regex', j, pos));
      return pos;
    }
    const mergeQuotes = stop === '/';
    while (pos < innerEnd) {
      this.budget.progress();
      const ch = this.source[pos]!;
      if (ch === '"') {
        const [piece, next] = this.parseString(pos, innerEnd);
        this.addKid(expansion, piece);
        pos = next;
        continue;
      }
      if (ch === "'" && !mergeQuotes) {
        const close = skipSingleQuoted(this.source, this.budget, pos, innerEnd);
        this.addKid(expansion, this.frame('raw_string', pos, close));
        pos = close;
        continue;
      }
      let k = pos;
      let sinceTick = 0;
      while (k < innerEnd && this.source[k] !== '"' && this.source[k] !== stop) {
        if (++sinceTick >= SCAN_TICK_INTERVAL) {
          this.budget.progress();
          sinceTick = 0;
        }
        const ck = this.source[k]!;
        if (ck === "'") {
          if (!mergeQuotes) break;
          k = skipSingleQuoted(this.source, this.budget, k, innerEnd);
          continue;
        }
        if (ck === '\\' && k + 1 < innerEnd) {
          if (stop !== undefined && this.source[k + 1] === stop) {
            k++;
            break;
          }
          k += 2;
          continue;
        }
        k++;
      }
      if (k === pos) break;
      this.addKid(expansion, this.frame('regex', pos, k));
      pos = k;
    }
    return pos;
  }

  private parseExpansionValue(start: number, end: number): Frame[] {
    const raw = this.text(start, end);
    if (!/["'$`\\]/.test(raw)) {
      if (this.source.startsWith('? ', start)) return [this.frame('word', start, end)];
      for (let k = start + 1; k < end; k++) {
        const ch = this.source[k]!;
        if (ch !== ' ' && ch !== '\t' && ch !== '\r') continue;
        if (/[^ \t\r]/.test(this.source.slice(k + 1, end))) {
          return [
            this.frame('concatenation', start, end, [
              this.frame('word', start, k),
              this.frame('word', k, end),
            ]),
          ];
        }
        break;
      }
      return [this.frame('word', start, end)];
    }
    const value = this.parseLiteral(start, end);
    const pieces = value.type === 'concatenation' ? [...value.children] : [value];
    const trimmed: Frame[] = [];
    for (let p = 0; p < pieces.length; p++) {
      const piece = pieces[p]!;
      if (piece.type === 'word' && p + 1 < pieces.length && this.source[piece.start] !== '(') {
        let newEnd = piece.end;
        while (newEnd > piece.start && (this.source[newEnd - 1] === ' ' || this.source[newEnd - 1] === '\t' || this.source[newEnd - 1] === '\r')) {
          newEnd--;
        }
        if (newEnd === piece.start) continue;
        trimmed.push(newEnd === piece.end ? piece : this.frame('word', piece.start, newEnd));
      } else {
        trimmed.push(piece);
      }
    }
    if (trimmed.length === 2 && trimmed[0]!.type === 'command_substitution') return trimmed;
    if (trimmed.length === 1) return trimmed;
    if (trimmed.length === 0) return [];
    return [this.frame('concatenation', start, end, trimmed)];
  }

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

  private parseCommandSubstitution(i: number, rangeEnd: number): [Frame, number] {
    const scan = scanBalancedStatements(this.source, this.budget, i + 1, rangeEnd);
    const close = scan.end;
    if (!scan.balanced) this.hasError = true;
    const innerEnd = scan.balanced ? close - 1 : close;
    const substitution = this.frame('command_substitution', i, close, [this.anon('$(', i, i + 2)]);
    let children = this.parseScopedStatements(i + 2, innerEnd);
    if (
      children.length === 1 &&
      children[0]!.type === 'redirected_statement' &&
      children[0]!.children.length > 0 &&
      children[0]!.children.every((child) => child.type === 'file_redirect' || child.type === 'herestring_redirect')
    ) {
      children = children[0]!.children;
    }
    for (const child of children) {
      this.addKid(substitution, child);
    }
    if (scan.balanced) this.addKid(substitution, this.anon(')', close - 1, close));
    return [substitution, close];
  }

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

  private newExprState(start: number, end: number, mode: ExprMode): ExprState {
    return { pos: start, end, mode, lookahead: null, parenDepth: 0, expectOperator: false };
  }

  private exprPeek(st: ExprState): ExprToken {
    st.lookahead ??= this.scanExprToken(st);
    return st.lookahead;
  }

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

  private parseArithmeticExpansion(i: number, rangeEnd: number): [Frame, number] {
    const scan = this.scanBalanced(i + 1, rangeEnd, '(', ')');
    const close = scan.end;
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

  private parseExpression(st: ExprState, minPrecedence: number): Frame | null {
    let left: Frame | null;
    const head = this.exprPeek(st);
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
          this.hasError = true;
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
      if (st.mode === 'test' && token.kind === 'op' && token.text === '=~') {
        const right = this.parseTestRegex(st);
        const kids: Frame[] = [left, this.anon('=~', token.start, token.end)];
        if (right === null) this.hasError = true;
        else kids.push(...right);
        left = this.frame('binary_expression', left.start, this.endOf(kids, token.end), kids);
        st.expectOperator = true;
        continue;
      }
      const rightPrecedence = token.text === '**' && st.mode === 'test' ? precedence : precedence + 1;
      let right: Frame | null;
      if (st.mode === 'test' && (token.text === '==' || token.text === '!=')) {
        const pattern = this.tryParseTestPattern(st);
        if (pattern !== null) {
          const kids: Frame[] = [left, this.anon(token.text, token.start, token.end), ...pattern.frames];
          left = this.frame('binary_expression', left.start, pattern.end, kids);
          st.expectOperator = true;
          continue;
        }
      }
      right = this.parseExpression(st, rightPrecedence);
      if (right === null) {
        this.hasError = true;
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
          this.hasError = true;
        }
        st.parenDepth--;
        this.exprDepth--;
        return this.frame('parenthesized_expression', token.start, end, kids);
      }
      case 'op':
      case 'testop':
      case 'unknown': {
        this.exprNext(st);
        this.hasError = true;
        return this.frame('ERROR', token.start, token.end);
      }
    }
  }

  private parseTestRegex(st: ExprState): Frame[] | null {
    let i = st.pos;
    while (i < st.end && (this.source[i] === ' ' || this.source[i] === '\t' || this.source[i] === '\r')) i++;
    st.pos = i;
    st.lookahead = null;
    if (i >= st.end) return null;
    const ch = this.source[i]!;
    if (ch === '"') {
      const [piece, next] = this.parseString(i, st.end);
      st.pos = next;
      return [piece];
    }
    if (ch === '$') {
      const operand = this.parseExpression(st, PREC_TEST + 1);
      return operand === null ? null : [operand];
    }
    let j = i;
    let inQuote = false;
    let hasQuote = false;
    let parenDepth = 0;
    let sinceTick = 0;
    while (j < st.end) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const c = this.source[j]!;
      if (!inQuote && parenDepth === 0 && (c === ' ' || c === '\t' || c === '\r' || c === '\n')) break;
      if (c === "'") {
        hasQuote = true;
        inQuote = !inQuote;
        j++;
        continue;
      }
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (!inQuote) {
        if (c === '(') parenDepth++;
        else if (c === ')') {
          if (parenDepth === 0) break;
          parenDepth--;
        }
      }
      j++;
    }
    st.pos = j;
    if (ch === "'") {
      if (/^'[^']*'\w*$/.test(this.text(i, j))) return [this.parseLiteral(i, j)];
      return [this.frame('regex', i, j)];
    }
    if (hasQuote) return [this.parseLiteral(i, j)];
    return [this.frame('regex', i, j)];
  }

  private tryParseTestPattern(st: ExprState): { frames: Frame[]; end: number } | null {
    let i = st.pos;
    while (i < st.end && (this.source[i] === ' ' || this.source[i] === '\t' || this.source[i] === '\r')) i++;
    if (i >= st.end) return null;
    let depth = 0;
    let j = i;
    let sawGroup = false;
    let sawConstruct = false;
    while (j < st.end) {
      const ch = this.source[j]!;
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '"') {
        sawConstruct = true;
        j = skipDoubleQuoted(this.source, this.budget, j, st.end);
        continue;
      }
      if (ch === "'") {
        sawConstruct = true;
        j = skipSingleQuoted(this.source, this.budget, j, st.end);
        continue;
      }
      if (ch === '`') {
        sawConstruct = true;
        j = skipBacktick(this.source, this.budget, j, st.end);
        continue;
      }
      if (ch === '$') {
        sawConstruct = true;
        j = skipDollar(this.source, this.budget, j, st.end);
        continue;
      }
      if ((ch === '?' || ch === '*' || ch === '+' || ch === '@' || ch === '!') && this.source[j + 1] === '(') {
        sawGroup = true;
      }
      if (ch === '(') {
        depth++;
        j++;
        continue;
      }
      if (ch === ')') {
        if (depth > 0) {
          depth--;
          j++;
          continue;
        }
        break;
      }
      if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) break;
      j++;
    }
    const hasGroup = sawGroup;
    const hasConstruct = sawConstruct;
    if (hasGroup && !hasConstruct) {
      if (!this.extglobGroupAccepted(i, j)) return null;
      st.pos = j;
      st.lookahead = null;
      return { frames: [this.frame('extglob_pattern', i, j)], end: j };
    }
    if (!hasConstruct) return null;
    const pieces = this.parseExtglobBlob(i, j, hasGroup ? (s, e) => this.extglobGroupAccepted(s, e) : undefined);
    if (pieces === null) return null;
    st.pos = j;
    st.lookahead = null;
    return { frames: pieces, end: j };
  }

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

  private isBarePieces(frame: Frame): boolean {
    return frame.children.every((child) => child.type === 'word' || child.type === 'number');
  }

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
    if (c0 === '-' && isAlpha(text[i]!)) return false;
    if (text[i] === '-') {
      i++;
      while (i < text.length && isAlnum(text[i]!)) i++;
      const after = i < text.length ? text[i]! : nextChar;
      if (after === ')' || after === '\\' || after === '.') return false;
      if (i >= text.length) return true;
    }
    if (c0 !== '[' && !isAlnum(text[i]!) && !'[?/\\_*'.includes(text[i]!)) return false;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '\\') {
        const after = text[i + 1];
        if (after === ' ' || after === '\t' || after === '\r' || after === '"') i++;
        continue;
      }
      if (!isAlpha(ch) && ch !== '.') sawNonAlphaDot = true;
    }
    return sawNonAlphaDot;
  }

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
        i += 2;
        continue;
      }
      break;
    }
    st.pos = i;
    if (i >= end) return { kind: 'end', start: i, end: i, text: '' };
    const ch = this.source[i]!;
    if (st.mode === 'test') return this.scanTestToken(st, i, ch);

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
        const sub = this.scanBalanced(j, end, '[', ']');
        if (!sub.balanced) this.hasError = true;
        const indexEnd = sub.balanced ? sub.end - 1 : sub.end;
        const kids: Frame[] = [this.frame('variable_name', i, j), this.anon('[', j, j + 1)];
        if (indexEnd > j + 1) {
          kids.push(this.parseLiteral(j + 1, indexEnd));
        } else {
          this.hasError = true;
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
      this.hasError = true;
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
    st.pos = i + 1;
    return { kind: 'unknown', start: i, end: i + 1, text: ch };
  }

  private scanTestToken(st: ExprState, i: number, ch: string): ExprToken {
    const end = st.end;
    if (ch === '(') {
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
        const two = this.source.slice(i, i + 2);
        const wide = two === '==' || two === '=~' || two === '!=' ? 2 : 1;
        st.pos = i + wide;
        return { kind: 'op', start: i, end: i + wide, text: this.text(i, i + wide) };
      }
      const after = this.source[i + 1];
      if (ch === '!' && (after === undefined || after === ' ' || after === '\t' || after === '\r' || i + 1 >= end)) {
        st.pos = i + 1;
        return { kind: 'op', start: i, end: i + 1, text: '!' };
      }
    }
    if (ch === '-' && /[A-Za-z]/.test(this.source[i + 1] ?? '')) {
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
    if (j === i) j++;
    st.pos = j;
    if (j === i + 1 && (ch === '+' || ch === '*' || ch === '/' || ch === '%')) {
      return { kind: 'op', start: i, end: j, text: ch };
    }
    return { kind: 'word', start: i, end: j, text: this.text(i, j) };
  }

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

  private parseTestCommand(): Frame {
    const openToken = this.lexer.next();
    const double = this.source[openToken.end] === '[';
    const opener = double ? '[[' : '[';
    const closer = double ? ']]' : ']';
    const exprStart = openToken.end + (double ? 1 : 0);
    const kids: Frame[] = [this.anon(opener, openToken.start, exprStart)];
    const scan = this.scanTestCloser(exprStart, double);
    if (!double && scan.closerStart > exprStart && this.rangeHasTopLevelRedirect(exprStart, scan.closerStart)) {
      const statements = this.parseScopedStatements(exprStart, scan.closerStart);
      kids.push(...statements);
      let end = scan.closerStart;
      if (scan.found) {
        kids.push(this.anon(closer, scan.closerStart, scan.afterCloser));
        end = scan.afterCloser;
      } else {
        this.hasError = true;
      }
      this.lexer.reposition(end);
      return this.frame('test_command', openToken.start, end, kids);
    }
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

  private rangeHasTopLevelRedirect(start: number, end: number): boolean {
    let j = start;
    let sinceTick = 0;
    while (j < end) {
      if (++sinceTick >= SCAN_TICK_INTERVAL) {
        this.budget.progress();
        sinceTick = 0;
      }
      const ch = this.source[j]!;
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
      if ((ch === '<' || ch === '>') && this.source[j + 1] !== '(') return true;
      j++;
    }
    return false;
  }

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
        i += 2;
        continue;
      }
      if (ch === '$') {
        if (this.source[i + 1] === "'") {
          i++;
          continue;
        }
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

  private scanBalanced(i: number, end: number, open: string, close: string): BalancedScan {
    return scanBalanced(this.source, this.budget, i, end, open, close);
  }
}

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

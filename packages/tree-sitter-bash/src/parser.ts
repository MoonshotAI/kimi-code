// src/parser.ts
//
// Recursive-descent bash parser. One method per tree-sitter-bash grammar
// rule (parseList ↔ list, parsePipeline ↔ pipeline, parseCommand ↔ command,
// …), producing node ranges and child layouts that match the real
// tree-sitter-bash 0.25.0 tree for the M1 syntax subset.
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
// heredoc) keep their partial node and set hasError; tokens that cannot
// start or continue a statement are wrapped in an ERROR node and parsing
// continues. No parser-internal exception is expected to escape; parse()
// still guards against it.
//
// Depth guard: word-level substitutions ($( … ) / `…` / <( … )) recurse via
// fresh sub-Parser instances bounded to their source range (tracked by
// `depth`), subshells recurse within one parser (`scopeDepth`), and the
// parseLiteral ↔ parseString / parseExpansion chain behind ${ … } nesting
// has its own counter (`literalDepth`). All three are capped at
// MAX_PARSE_DEPTH; beyond it the construct is skipped and reported with an
// ERROR node instead of risking a stack overflow.

import type { ParseBudget } from '#/budget';
import { EXPANSION_OPERATORS, FILE_REDIRECT_OPERATORS, SPECIAL_VARIABLE_CHARS } from '#/grammar';
import { Lexer, scanBalanced, skipBacktick, skipSingleQuoted } from '#/lexer';
import type { BalancedScan, HeredocBody, HeredocSpec, Token } from '#/lexer';
import { SyntaxNodeBuilder } from '#/node';

/** Maximum nesting of scopes (subshells, command substitutions, …). */
export const MAX_PARSE_DEPTH = 500;

const FILE_REDIRECT_OP_SET: ReadonlySet<string> = new Set(FILE_REDIRECT_OPERATORS);
const NUMBER_RE = /^-?(0x)?[0-9]+(#[0-9A-Za-z@_]+)?$/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const ASSIGNMENT_SPLIT_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/;

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
  /** True while parsing inside a heredoc's line tail: a second heredoc
   *  cannot be represented and degrades to ERROR (see parseHeredocRedirect). */
  private noHeredoc = false;

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

  private isStatementStart(token: Token): boolean {
    if (token.type === 'word' || token.type === 'io_number') return true;
    if (token.type !== 'op') return false;
    const text = this.tokenText(token);
    return text === '(' || text === '<<<' || text === '<<' || text === '<<-' || isFileRedirectOp(text);
  }

  // ------------------------------------------------------------ entry point

  /** program: the whole source as one statement list. */
  parseProgram(): Frame {
    this.lexer = new Lexer(this.source, this.budget, 0, this.source.length);
    const children = this.parseStatementList(false);
    return this.frame('program', 0, this.source.length, children);
  }

  /** Parse a sub-range as a statement list (body of $( … ), ` … `, <( … )). */
  private parseScopedStatements(start: number, end: number): Frame[] {
    if (this.depth + 1 >= MAX_PARSE_DEPTH) {
      this.hasError = true;
      return [this.frame('ERROR', start, end)];
    }
    const sub = new Parser(this.source, this.budget, this.depth + 1);
    sub.lexer = new Lexer(this.source, this.budget, start, end);
    const children = sub.parseStatementList(false);
    if (sub.hasError) this.hasError = true;
    return children;
  }

  // -------------------------------------------------------- statement lists

  /** _statements: statements separated/terminated by ; & and newlines. */
  private parseStatementList(stopAtParen: boolean): Frame[] {
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
        // A newline that scanned heredoc bodies belongs to the heredoc
        // redirects (it sits inside their range); it is not a program-level
        // terminator node.
        if (token.heredocBodies.length === 0) {
          children.push(this.anon('\n', token.start, token.end));
        }
        needTerminator = false;
        continue;
      }
      if (token.type === 'comment') {
        this.lexer.next();
        children.push(this.frame('comment', token.start, token.end));
        continue;
      }
      const op = token.type === 'op' ? this.tokenText(token) : '';
      if (token.type === 'op' && op === ')' && stopAtParen) {
        this.failOpenHeredocs();
        break;
      }
      if (token.type === 'op' && (op === ';' || op === '&' || op === ';;')) {
        this.lexer.next();
        children.push(this.anon(op, token.start, token.end));
        needTerminator = false;
        continue;
      }
      if (token.type === 'op' && (op === ')' || op === '&&' || op === '||' || op === '|' || op === '|&')) {
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

  /** _statement_not_pipeline for the M1 subset: command, subshell,
   *  negated_command, variable_assignment(s), redirected_statement. */
  private parseStatementNotPipeline(): Frame {
    const token = this.lexer.peek();
    let inner: Frame | null = null;
    if (token.type === 'op' && this.tokenText(token) === '(') {
      inner = this.parseSubshell();
    } else if (token.type === 'word' && this.tokenText(token) === '!') {
      inner = this.parseNegatedCommand();
    } else {
      inner = this.parseCommand();
    }
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

  /** negated_command: `!` followed by a command or subshell. */
  private parseNegatedCommand(): Frame {
    const bang = this.lexer.next();
    const kids: Frame[] = [this.anon('!', bang.start, bang.end)];
    let end = bang.end;
    const token = this.lexer.peek();
    if (token.type === 'op' && this.tokenText(token) === '(') {
      const subshell = this.parseSubshell();
      kids.push(subshell);
      end = subshell.end;
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
    const inner = this.parseStatementList(true);
    this.scopeDepth--;
    kids.push(...inner);
    let end = inner.length > 0 ? inner.at(-1)!.end : open.end;
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

  // --------------------------------------------------------------- commands

  /**
   * command: leading variable_assignment / redirect prefix, command_name,
   * then arguments and inline herestring redirects. Returns null when no
   * command name is present and nothing was consumed; a nameless prefix is
   * assembled into variable_assignment(s) / redirected_statement here.
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
    const nameToken = this.lexer.next();
    const name = this.frame('command_name', nameToken.start, nameToken.end, [
      this.parseLiteral(nameToken.start, nameToken.end),
    ]);
    const command = this.frame('command', start, nameToken.end, [...prefix, name]);
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === 'word') {
        const argument = this.parseWordArgument();
        this.addKid(command, argument);
        command.end = argument.end;
        continue;
      }
      if (token.type === 'op' && this.tokenText(token) === '<<<') {
        const herestring = this.parseHerestringRedirect(null);
        this.addKid(command, herestring);
        command.end = herestring.end;
        continue;
      }
      break;
    }
    return command;
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

  /** variable_assignment: NAME ( = | += ) value — the word token is split
   *  into variable_name, the operator, and a value parsed from the rest of
   *  the token (which may hold quotes/expansions). */
  private parseVariableAssignment(token: Token): Frame {
    const text = this.tokenText(token);
    const match = ASSIGNMENT_SPLIT_RE.exec(text)!;
    const nameEnd = token.start + match[1]!.length;
    const opEnd = nameEnd + match[2]!.length;
    const kids: Frame[] = [
      this.frame('variable_name', token.start, nameEnd),
      this.anon(match[2]!, nameEnd, opEnd),
    ];
    if (opEnd < token.end) {
      kids.push(this.parseLiteral(opEnd, token.end));
    }
    return this.frame('variable_assignment', token.start, token.end, kids);
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
    const first = this.lexer.next();
    let end = first.end;
    for (;;) {
      const token = this.lexer.peek();
      if (token.type !== 'word' || token.start !== end) break;
      this.lexer.next();
      end = token.end;
    }
    return this.parseLiteral(first.start, end);
  }

  /**
   * _literal over a source range: a single word/number/string/expansion/…,
   * or a concatenation of adjacent pieces. The single characters { } [ ]
   * become their own word pieces, matching tree-sitter-bash's
   * _special_character alias.
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
        const dollar = this.parseDollar(i, end);
        if (dollar !== null) {
          pieces.push(dollar[0]);
          i = dollar[1];
        } else {
          // Bare `$` (not followed by anything expandable).
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
      if (ch === '{' || ch === '}' || ch === '[' || ch === ']') {
        pieces.push(this.frame('word', i, i + 1));
        i++;
        continue;
      }
      // Bare run of ordinary word characters (escapes included as-is).
      let j = i;
      let sinceTick = 0;
      while (j < end) {
        if (++sinceTick >= 2048) {
          this.budget.progress();
          sinceTick = 0;
        }
        const next = this.source[j]!;
        if (next === '"' || next === "'" || next === '`' || next === '$') break;
        if (next === '{' || next === '}' || next === '[' || next === ']') break;
        if ((next === '<' || next === '>') && this.source[j + 1] === '(' && j + 1 < end) break;
        if (next === '\\' && j + 1 < end) {
          j += 2;
          continue;
        }
        j++;
      }
      if (j === i) j++; // defensive: never stall
      pieces.push(this.frame('word', i, j));
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
      if (++sinceTick >= 2048) {
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
   *  command_substitution, or the arithmetic placeholder. Returns null for a
   *  bare `$` (including the M2 forms $"…" and $'…'). */
  private parseDollar(i: number, rangeEnd: number): [Frame, number] | null {
    const next = this.source[i + 1];
    if (next === '(' && i + 1 < rangeEnd) {
      if (this.source[i + 2] === '(') return this.parseArithmeticExpansion(i, rangeEnd);
      return this.parseCommandSubstitution(i, rangeEnd);
    }
    if (next === '{' && i + 1 < rangeEnd) return this.parseExpansion(i, rangeEnd);
    if (next !== undefined && /[\w]/.test(next)) {
      let j = i + 1;
      while (j < rangeEnd && /[\w]/.test(this.source[j]!)) j++;
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

  /** expansion: ${ … } with optional prefix operators (! #), a variable_name
   *  / special_variable_name / subscript, an optional infix operator
   *  (:- ## % / …), and a value parsed as a literal. */
  private parseExpansion(i: number, rangeEnd: number): [Frame, number] {
    const scan = this.scanBalanced(i + 1, rangeEnd, '{', '}');
    const close = scan.end;
    const terminated = scan.balanced;
    if (!terminated) this.hasError = true;
    const innerEnd = terminated ? close - 1 : close;
    const expansion = this.frame('expansion', i, close, [this.anon('${', i, i + 2)]);
    let j = i + 2;
    // Prefix operators: ${#v} (length), ${!v} (indirect).
    while (j < innerEnd && (this.source[j] === '#' || this.source[j] === '!')) {
      const after = this.source[j + 1];
      if (after === undefined || j + 1 >= innerEnd || !/[\w@*#?$!-]/.test(after)) break;
      this.addKid(expansion, this.anon(this.source[j]!, j, j + 1));
      j++;
    }
    // The variable itself.
    let hasName = false;
    if (j < innerEnd && /[\w]/.test(this.source[j]!)) {
      let nameEnd = j;
      while (nameEnd < innerEnd && /[\w]/.test(this.source[nameEnd]!)) nameEnd++;
      this.addKid(expansion, this.frame('variable_name', j, nameEnd));
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
    // Infix operator plus an optional value.
    if (j < innerEnd) {
      for (const operator of EXPANSION_OPERATORS) {
        if (j + operator.length <= innerEnd && this.source.startsWith(operator, j)) {
          this.addKid(expansion, this.anon(operator, j, j + operator.length));
          j += operator.length;
          break;
        }
      }
      if (j < innerEnd) {
        this.addKid(expansion, this.parseLiteral(j, innerEnd));
      }
    }
    if (terminated) this.addKid(expansion, this.anon('}', close - 1, close));
    return [expansion, close];
  }

  /** command_substitution: $( _statements ) */
  private parseCommandSubstitution(i: number, rangeEnd: number): [Frame, number] {
    const scan = this.scanBalanced(i + 1, rangeEnd, '(', ')');
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

  /** process_substitution: ( <( | >( ) _statements ) */
  private parseProcessSubstitution(i: number, rangeEnd: number): [Frame, number] {
    const scan = this.scanBalanced(i + 1, rangeEnd, '(', ')');
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

  /**
   * TODO(M2): real arithmetic expansion parsing ($(( … )) with
   * binary_expression / number / … children). For M1 the whole construct is
   * surfaced as an arithmetic_expansion whose raw inner text sits in a
   * single word child, so the node type and range are already correct and
   * downstream consumers can rely on both.
   */
  private parseArithmeticExpansion(i: number, rangeEnd: number): [Frame, number] {
    const scan = this.scanBalanced(i + 1, rangeEnd, '(', ')');
    const close = scan.end;
    if (!scan.balanced) this.hasError = true;
    // The content sits between `$((` and the final `))`.
    const closed = scan.balanced && close - 2 >= i + 3 && this.source[close - 2] === ')';
    const innerStart = Math.min(i + 3, close);
    const innerEnd = closed ? close - 2 : close;
    const expansion = this.frame('arithmetic_expansion', i, close, [this.anon('$((', i, innerStart)]);
    if (innerEnd > innerStart) {
      this.addKid(expansion, this.frame('word', innerStart, innerEnd));
    }
    if (closed) {
      this.addKid(expansion, this.anon('))', innerEnd, close));
    }
    return [expansion, close];
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
      if (++sinceTick >= 2048) {
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

/**
 * .rules file parser — a restricted data-subset of the codex Starlark call
 * syntax: `name(key = value, ...)` statements only, `#` comments, string /
 * string-array / boolean / number literals. Unknown rule names and malformed
 * input raise RulesSyntaxError with line/column so loaders can fail closed
 * or report the offending file.
 */

import type {
  ExecRule,
  NetworkRule,
  PrefixRule,
  RuleDecision,
  RuleSource,
} from './types';

export class RulesSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`rules syntax error at ${line}:${column} — ${message}`);
    this.name = 'RulesSyntaxError';
  }
}

type TokenType =
  | 'ident'
  | 'string'
  | 'number'
  | 'boolean'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'equals'
  | 'comma'
  | 'eof';

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const push = (type: TokenType, value: string, startLine: number, startCol: number) =>
    tokens.push({ type, value, line: startLine, column: startCol });

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      i += 1;
      line += 1;
      col = 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      col += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') {
        i += 1;
        col += 1;
      }
      continue;
    }
    const startLine = line;
    const startCol = col;
    if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '=' || ch === ',') {
      const type = {
        '(': 'lparen',
        ')': 'rparen',
        '[': 'lbracket',
        ']': 'rbracket',
        '=': 'equals',
        ',': 'comma',
      }[ch] as TokenType;
      push(type, ch, startLine, startCol);
      i += 1;
      col += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      col += 1;
      let value = '';
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === quote) {
          closed = true;
          i += 1;
          col += 1;
          break;
        }
        if (c === '\\' && i + 1 < text.length) {
          const n = text[i + 1]!;
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r' };
          value += escapes[n] ?? n;
          i += 2;
          col += 2;
          continue;
        }
        if (c === '\n') {
          throw new RulesSyntaxError('unterminated string literal', startLine, startCol);
        }
        value += c;
        i += 1;
        col += 1;
      }
      if (!closed) {
        throw new RulesSyntaxError('unterminated string literal', startLine, startCol);
      }
      push('string', value, startLine, startCol);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const start = i;
      if (ch === '-') {
        i += 1;
        col += 1;
      }
      while (i < text.length && /[0-9.]/.test(text[i] ?? '')) {
        i += 1;
        col += 1;
      }
      push('number', text.slice(start, i), startLine, startCol);
      continue;
    }
    if (/[A-Za-z_*]/.test(ch)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_./-]/.test(text[i] ?? '')) {
        i += 1;
        col += 1;
      }
      const word = text.slice(start, i);
      push(word === 'true' || word === 'false' ? 'boolean' : 'ident', word, startLine, startCol);
      continue;
    }
    throw new RulesSyntaxError(`unexpected character ${JSON.stringify(ch)}`, startLine, startCol);
  }
  tokens.push({ type: 'eof', value: '', line, column: col });
  return tokens;
}

type Literal = string | number | boolean | readonly string[];

interface Call {
  readonly name: string;
  readonly kwargs: Readonly<Record<string, Literal>>;
  readonly line: number;
  readonly column: number;
}

function parseCalls(tokens: readonly Token[]): Call[] {
  const calls: Call[] = [];
  let pos = 0;

  const eof = tokens.at(-1)!;
  const peek = () => tokens[pos] ?? eof;
  const next = () => tokens[pos++] ?? eof;
  const fail = (message: string, tok: Token): never => {
    throw new RulesSyntaxError(message, tok.line, tok.column);
  };
  const expect = (type: TokenType, what: string): Token => {
    const tok = next();
    if (tok.type !== type) {
      return fail(`expected ${what}, found ${tok.type} ${JSON.stringify(tok.value)}`, tok);
    }
    return tok;
  };

  const parseLiteral = (): Literal => {
    const tok = next();
    switch (tok.type) {
      case 'string':
        return tok.value;
      case 'number':
        return Number(tok.value);
      case 'boolean':
        return tok.value === 'true';
      case 'lbracket': {
        const items: string[] = [];
        if (peek().type === 'rbracket') {
          next();
          return items;
        }
        for (;;) {
          const item = next();
          if (item.type !== 'string') {
            fail(`expected string in array, found ${item.type} ${JSON.stringify(item.value)}`, item);
          }
          items.push(item.value);
          const sep = next();
          if (sep.type === 'rbracket') {
            return items;
          }
          if (sep.type !== 'comma') {
            fail(`expected ',' or ']' in array, found ${sep.type}`, sep);
          }
          if (peek().type === 'rbracket') {
            next();
            return items;
          }
        }
      }
      default:
        return fail(`expected literal value, found ${tok.type} ${JSON.stringify(tok.value)}`, tok);
    }
  };

  while (peek().type !== 'eof') {
    const name = expect('ident', 'rule name');
    expect('lparen', "'(' after rule name");
    const kwargs: Record<string, Literal> = {};
    if (peek().type !== 'rparen') {
      for (;;) {
        const key = expect('ident', 'keyword argument name');
        expect('equals', "'=' after argument name");
        kwargs[key.value] = parseLiteral();
        const sep = next();
        if (sep.type === 'rparen') {
          break;
        }
        if (sep.type !== 'comma') {
          fail(`expected ',' or ')' after argument, found ${sep.type}`, sep);
        }
        if (peek().type === 'rparen') {
          next();
          break;
        }
      }
    } else {
      next();
    }
    calls.push({ name: name.value, kwargs, line: name.line, column: name.column });
  }
  return calls;
}

const DECISIONS: readonly string[] = ['allow', 'prompt', 'forbidden'];

function requiredString(call: Call, key: string): string {
  const v = call.kwargs[key];
  if (typeof v !== 'string') {
    throw new RulesSyntaxError(`'${key}' must be a string`, call.line, call.column);
  }
  return v;
}

function requiredStringArray(call: Call, key: string): readonly string[] {
  const v = call.kwargs[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new RulesSyntaxError(`'${key}' must be an array of strings`, call.line, call.column);
  }
  return v;
}

function optionalString(call: Call, key: string): string | undefined {
  const v = call.kwargs[key];
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== 'string') {
    throw new RulesSyntaxError(`'${key}' must be a string`, call.line, call.column);
  }
  return v;
}

function decisionOf(call: Call): RuleDecision {
  const v = requiredString(call, 'decision');
  if (!DECISIONS.includes(v)) {
    throw new RulesSyntaxError(
      `'decision' must be one of ${DECISIONS.join(', ')}`,
      call.line,
      call.column,
    );
  }
  return v as RuleDecision;
}

function callToRule(call: Call, source: RuleSource): ExecRule {
  const base = {
    decision: decisionOf(call),
    justification: optionalString(call, 'justification'),
    source,
  };
  switch (call.name) {
    case 'prefix_rule': {
      const pattern = requiredStringArray(call, 'pattern');
      if (pattern.length === 0) {
        throw new RulesSyntaxError("'pattern' must not be empty", call.line, call.column);
      }
      const rule: PrefixRule = { kind: 'prefix_rule', pattern, ...base };
      return rule;
    }
    case 'network_rule': {
      const host = requiredString(call, 'host');
      const rule: NetworkRule = {
        kind: 'network_rule',
        host,
        protocol: optionalString(call, 'protocol'),
        ...base,
      };
      return rule;
    }
    default:
      throw new RulesSyntaxError(
        `unknown rule '${call.name}' (supported: prefix_rule, network_rule)`,
        call.line,
        call.column,
      );
  }
}

export function parseRulesFile(text: string, source: RuleSource): ExecRule[] {
  return parseCalls(tokenize(text)).map((call) => callToRule(call, source));
}

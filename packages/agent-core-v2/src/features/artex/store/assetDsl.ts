import type { ArtexAsset } from '#/features/artex/protocol/index';

export type AssetDslOp = '=' | '==' | '!=' | '>' | '>=' | '<' | '<=';

export interface AssetDslExpr {
  readonly field: string;
  readonly op: AssetDslOp;
  readonly value: string;
}

export type AssetDslAstNode =
  | { readonly kind: 'and'; readonly children: readonly AssetDslAstNode[] }
  | { readonly kind: 'or'; readonly children: readonly AssetDslAstNode[] }
  | { readonly kind: 'not'; readonly child: AssetDslAstNode }
  | { readonly kind: 'leaf'; readonly expr: AssetDslExpr };

type StringAssetKey =
  | 'domain'
  | 'rootDomain'
  | 'ip'
  | 'url'
  | 'pageTitle'
  | 'icp'
  | 'serviceName'
  | 'appName'
  | 'bundleId'
  | 'category'
  | 'appIcp'
  | 'method'
  | 'serviceType'
  | 'recordType';

type NumericAssetKey = 'port' | 'statusCode';

const KNOWN_STRING_FIELDS: Readonly<Record<string, StringAssetKey>> = {
  domain: 'domain',
  root_domain: 'rootDomain',
  ip: 'ip',
  url: 'url',
  page_title: 'pageTitle',
  title: 'pageTitle',
  icp: 'icp',
  service_name: 'serviceName',
  app_name: 'appName',
  bundle_id: 'bundleId',
  category: 'category',
  app_icp: 'appIcp',
  method: 'method',
  service_type: 'serviceType',
  record_type: 'recordType',
};

const KNOWN_ARRAY_FIELDS: Readonly<Record<string, 'technologies'>> = {
  technology: 'technologies',
  technologies: 'technologies',
  tech: 'technologies',
};

const KNOWN_NUMERIC_FIELDS: Readonly<Record<string, NumericAssetKey>> = {
  port: 'port',
  status_code: 'statusCode',
  status: 'statusCode',
};

function isKnownField(field: string): boolean {
  const f = field.toLowerCase();
  return (
    f in KNOWN_STRING_FIELDS ||
    f in KNOWN_ARRAY_FIELDS ||
    f in KNOWN_NUMERIC_FIELDS ||
    f === 'company_id' ||
    f === 'task_id'
  );
}

type Token =
  | { readonly kind: 'FIELD'; readonly expr: AssetDslExpr }
  | { readonly kind: 'BARE'; readonly expr: AssetDslExpr }
  | { readonly kind: 'AND' }
  | { readonly kind: 'OR' }
  | { readonly kind: 'NOT' }
  | { readonly kind: 'LPAREN' }
  | { readonly kind: 'RPAREN' }
  | { readonly kind: 'EOF' };

function isIdentStart(ch: string): boolean {
  return (
    ch === '_' ||
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z')
  );
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

function readToken(source: string, pos: number): { readonly value: string; readonly end: number } {
  if (pos >= source.length) return { value: '', end: pos };
  if (source[pos] === '"') {
    let i = pos + 1;
    let out = '';
    while (i < source.length && source[i] !== '"') {
      if (source[i] === '\\' && i + 1 < source.length) {
        i += 1;
      }
      out += source[i];
      i += 1;
    }
    if (i < source.length) i += 1;
    return { value: out, end: i };
  }
  let i = pos;
  while (
    i < source.length &&
    !isWhitespace(source[i]!) &&
    source[i] !== '(' &&
    source[i] !== ')'
  ) {
    i += 1;
  }
  return { value: source.slice(pos, i), end: i };
}

function tryParseFieldExpr(
  source: string,
  pos: number,
): { readonly expr: AssetDslExpr; readonly end: number } | undefined {
  let i = pos;
  if (i >= source.length || !isIdentStart(source[i]!)) return undefined;
  while (i < source.length && isIdentChar(source[i]!)) {
    i += 1;
  }
  const field = source.slice(pos, i).toLowerCase();
  if (!isKnownField(field) || i >= source.length) return undefined;

  let op: AssetDslOp;
  const two = source.slice(i, i + 2);
  if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
    op = two;
    i += 2;
  } else {
    const one = source[i];
    if (one === '=' || one === '>' || one === '<') {
      op = one;
      i += 1;
    } else {
      return undefined;
    }
  }

  const { value, end } = readToken(source, i);
  if (end === i) return undefined;
  return { expr: { field, op, value }, end };
}

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    while (i < source.length && isWhitespace(source[i]!)) {
      i += 1;
    }
    if (i >= source.length) break;
    const ch = source[i]!;
    if (ch === '(') {
      tokens.push({ kind: 'LPAREN' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'RPAREN' });
      i += 1;
      continue;
    }
    const fieldExpr = tryParseFieldExpr(source, i);
    if (fieldExpr !== undefined) {
      tokens.push({ kind: 'FIELD', expr: fieldExpr.expr });
      i = fieldExpr.end;
      continue;
    }
    const { value: word, end } = readToken(source, i);
    if (word === '') {
      i += 1;
      continue;
    }
    switch (word.toUpperCase()) {
      case 'AND':
        tokens.push({ kind: 'AND' });
        break;
      case 'OR':
        tokens.push({ kind: 'OR' });
        break;
      case 'NOT':
        tokens.push({ kind: 'NOT' });
        break;
      default:
        tokens.push({ kind: 'BARE', expr: { field: '', op: '=', value: word } });
        break;
    }
    i = end;
  }
  tokens.push({ kind: 'EOF' });
  return tokens;
}

class DslParser {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'EOF' };
  }

  consume(): Token {
    const token = this.peek();
    this.pos += 1;
    return token;
  }

  parseOr(): AssetDslAstNode {
    const left = this.parseAnd();
    const children: AssetDslAstNode[] = [left];
    while (this.peek().kind === 'OR') {
      this.consume();
      children.push(this.parseAnd());
    }
    return children.length === 1 ? children[0]! : { kind: 'or', children };
  }

  private parseAnd(): AssetDslAstNode {
    const left = this.parseNot();
    const children: AssetDslAstNode[] = [left];
    while (this.peek().kind === 'AND') {
      this.consume();
      children.push(this.parseNot());
    }
    return children.length === 1 ? children[0]! : { kind: 'and', children };
  }

  private parseNot(): AssetDslAstNode {
    if (this.peek().kind === 'NOT') {
      this.consume();
      return { kind: 'not', child: this.parseNot() };
    }
    return this.parseAtom();
  }

  private parseAtom(): AssetDslAstNode {
    const token = this.peek();
    switch (token.kind) {
      case 'FIELD':
      case 'BARE':
        this.consume();
        return { kind: 'leaf', expr: token.expr };
      case 'LPAREN': {
        this.consume();
        const inner = this.parseOr();
        if (this.peek().kind !== 'RPAREN') {
          throw new Error("DSL syntax error: missing closing parenthesis ')'");
        }
        this.consume();
        return inner;
      }
      case 'EOF':
        throw new Error('DSL syntax error: incomplete expression');
      case 'AND':
      case 'OR':
      case 'NOT':
      case 'RPAREN':
        throw new Error(`DSL syntax error: unexpected token '${token.kind}'`);
      default: {
        const exhaustive: never = token;
        return exhaustive;
      }
    }
  }
}

function parseStrictInt(value: string, label: string): number {
  if (!/^-?\d+$/.test(value.trim())) {
    throw new Error(`${label} requires an integer value: ${value}`);
  }
  const n = Number(value.trim());
  if (!Number.isSafeInteger(n)) {
    throw new TypeError(`${label} requires an integer value: ${value}`);
  }
  return n;
}

function validateAst(node: AssetDslAstNode): void {
  switch (node.kind) {
    case 'and':
    case 'or':
      for (const child of node.children) validateAst(child);
      return;
    case 'not':
      validateAst(node.child);
      return;
    case 'leaf':
      validateExpr(node.expr);
      return;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function validateExpr(expr: AssetDslExpr): void {
  const f = expr.field.toLowerCase();
  if (f === '') return;

  if (f === 'task_id' || f === 'company_id') {
    parseStrictInt(expr.value, f);
    if (expr.op !== '=' && expr.op !== '==' && expr.op !== '!=') {
      throw new Error(`field ${f} does not support operator ${expr.op}`);
    }
    return;
  }

  if (f in KNOWN_NUMERIC_FIELDS) {
    parseStrictInt(expr.value, `field ${f}`);
    return;
  }

  if (f in KNOWN_ARRAY_FIELDS) {
    if (expr.op !== '=' && expr.op !== '==' && expr.op !== '!=') {
      throw new Error(`array field ${f} does not support operator ${expr.op}`);
    }
    return;
  }

  if (f in KNOWN_STRING_FIELDS) {
    if (expr.op !== '=' && expr.op !== '==' && expr.op !== '!=') {
      throw new Error(`string field ${f} does not support operator ${expr.op}`);
    }
    return;
  }

  throw new Error(`unknown field: ${f}`);
}

export function parseAssetDsl(dsl: string): AssetDslAstNode | undefined {
  if (dsl.trim() === '') return undefined;
  const tokens = tokenize(dsl);
  const parser = new DslParser(tokens);
  const ast = parser.parseOr();
  if (parser.peek().kind !== 'EOF') {
    throw new Error(`DSL syntax error: unexpected content '${parser.peek().kind}'`);
  }
  validateAst(ast);
  return ast;
}

export function validateAssetDsl(dsl: string): void {
  parseAssetDsl(dsl);
}

export function matchesAssetDsl(asset: ArtexAsset, ast: AssetDslAstNode | undefined): boolean {
  if (ast === undefined) return true;
  switch (ast.kind) {
    case 'and':
      return ast.children.every((child) => matchesAssetDsl(asset, child));
    case 'or':
      return ast.children.some((child) => matchesAssetDsl(asset, child));
    case 'not':
      return !matchesAssetDsl(asset, ast.child);
    case 'leaf':
      return matchesLeaf(asset, ast.expr);
    default: {
      const exhaustive: never = ast;
      return exhaustive;
    }
  }
}

export function compileAssetDsl(dsl: string): (asset: ArtexAsset) => boolean {
  const ast = parseAssetDsl(dsl);
  return (asset) => matchesAssetDsl(asset, ast);
}

function matchesLeaf(asset: ArtexAsset, expr: AssetDslExpr): boolean {
  const f = expr.field.toLowerCase();
  if (f === '') {
    return bareMatchesAsset(asset, expr.value.toLowerCase());
  }
  if (f === 'task_id') {
    const target = Number(expr.value.trim());
    const hit = asset.taskIds.includes(target);
    return expr.op === '!=' ? !hit : hit;
  }
  if (f === 'company_id') {
    const target = Number(expr.value.trim());
    const hit = asset.companyId === target;
    return expr.op === '!=' ? !hit : hit;
  }
  const numKey = KNOWN_NUMERIC_FIELDS[f];
  if (numKey !== undefined) {
    const actual = asset[numKey];
    if (actual === undefined) return false;
    const expected = Number(expr.value.trim());
    switch (expr.op) {
      case '=':
      case '==':
        return actual === expected;
      case '!=':
        return actual !== expected;
      case '>':
        return actual > expected;
      case '>=':
        return actual >= expected;
      case '<':
        return actual < expected;
      case '<=':
        return actual <= expected;
      default: {
        const exhaustive: never = expr.op;
        return exhaustive;
      }
    }
  }
  const arrKey = KNOWN_ARRAY_FIELDS[f];
  if (arrKey !== undefined) {
    const values = asset[arrKey];
    switch (expr.op) {
      case '=': {
        const needle = expr.value.toLowerCase();
        return values.some((item) => item.toLowerCase().includes(needle));
      }
      case '==':
        return values.some((item) => item === expr.value);
      case '!=':
        return !values.some((item) => item === expr.value);
      default:
        return false;
    }
  }
  const strKey = KNOWN_STRING_FIELDS[f];
  if (strKey !== undefined) {
    const actual = asset[strKey] ?? '';
    switch (expr.op) {
      case '=':
        return actual.toLowerCase().includes(expr.value.toLowerCase());
      case '==':
        return actual === expr.value;
      case '!=':
        return !actual.toLowerCase().includes(expr.value.toLowerCase());
      default:
        return false;
    }
  }
  return false;
}

function bareMatchesAsset(asset: ArtexAsset, needle: string): boolean {
  const scalars: readonly (string | undefined)[] = [
    asset.domain,
    asset.rootDomain,
    asset.ip,
    asset.url,
    asset.pageTitle,
    asset.icp,
    asset.serviceName,
    asset.appName,
    asset.appDescription,
    asset.bundleId,
    asset.serviceType,
  ];
  for (const scalar of scalars) {
    if (scalar !== undefined && scalar.toLowerCase().includes(needle)) return true;
  }
  for (const tech of asset.technologies) {
    if (tech.toLowerCase().includes(needle)) return true;
  }
  for (const bound of asset.boundDomains) {
    if (bound.toLowerCase().includes(needle)) return true;
  }
  return false;
}

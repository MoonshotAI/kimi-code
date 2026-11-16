import { doHttpJson } from '../http';
import { markdownTitle } from '../markdown';
import { validateHttpUrl } from '../ssrf';
import {
  cfgMap,
  cfgString,
  isStatusChangeItem,
  permanentError,
  severityLabel,
  statusLabel,
  type NotifyChannel,
  type NotifyMessage,
  type NotifyTransportOptions,
} from '../types';

export interface WebhookTemplateItem {
  readonly FindingID: number;
  readonly Name: string;
  readonly VulnClass: string;
  readonly Severity: string;
  readonly SeverityLabel: string;
  readonly Summary: string;
  readonly Assets: readonly string[];
  readonly DetailURL: string;
  readonly FromStatus: string;
  readonly ToStatus: string;
  readonly StatusLabel: string;
}

export interface WebhookTemplateData {
  readonly Title: string;
  readonly Batch: boolean;
  readonly Count: number;
  readonly Items: readonly WebhookTemplateItem[];
  readonly HomeURL: string;
  readonly SentAt: string;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH']);
const ALLOWED_FUNCS = new Set(['json', 'jsons', 'printf', 'index']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function buildWebhookTemplateData(
  message: NotifyMessage,
  nowMs: number = Date.now(),
): WebhookTemplateData {
  return {
    Title: markdownTitle(message),
    Batch: message.batch === true,
    Count: message.items.length,
    HomeURL: message.homeUrl ?? '',
    SentAt: new Date(nowMs).toISOString(),
    Items: message.items.map((it) => ({
      FindingID: it.findingId,
      Name: it.name,
      VulnClass: it.vulnclass,
      Severity: it.severity,
      SeverityLabel: severityLabel(it.severity),
      Summary: it.summary,
      Assets: [...it.assets],
      DetailURL: it.detailUrl ?? '',
      FromStatus: it.fromStatus ?? '',
      ToStatus: it.toStatus ?? '',
      StatusLabel: isStatusChangeItem(it)
        ? `${statusLabel(it.fromStatus ?? '')} → ${statusLabel(it.toStatus ?? '')}`
        : '',
    })),
  };
}

export function buildDefaultWebhookPayload(message: NotifyMessage): Record<string, unknown> {
  return {
    title: markdownTitle(message),
    batch: message.batch === true,
    count: message.items.length,
    items: message.items.map((it) => ({
      finding_id: it.findingId,
      name: it.name,
      vulnclass: it.vulnclass,
      severity: it.severity,
      summary: it.summary,
      assets: [...it.assets],
      detail_url: it.detailUrl ?? '',
    })),
  };
}

type TemplateNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'eval'; readonly pipeline: readonly string[] }
  | {
      readonly kind: 'range';
      readonly idxVar?: string;
      readonly valVar?: string;
      readonly expr: string;
      readonly body: readonly TemplateNode[];
      readonly elseBody: readonly TemplateNode[];
    }
  | {
      readonly kind: 'if';
      readonly expr: string;
      readonly body: readonly TemplateNode[];
      readonly elseBody: readonly TemplateNode[];
    };

interface RawToken {
  readonly kind: 'text' | 'action';
  readonly value: string;
  readonly trimLeft?: boolean;
  readonly trimRight?: boolean;
}

function tokenizeTemplate(source: string): RawToken[] {
  const tokens: RawToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('{{', cursor);
    if (start < 0) {
      tokens.push({ kind: 'text', value: source.slice(cursor) });
      break;
    }
    if (start > cursor) {
      tokens.push({ kind: 'text', value: source.slice(cursor, start) });
    }
    let exprStart = start + 2;
    let trimLeft = false;
    if (source[exprStart] === '-' && (source[exprStart + 1] === ' ' || source[exprStart + 1] === '\t' || source[exprStart + 1] === '\n' || source[exprStart + 1] === '\r')) {
      trimLeft = true;
      exprStart += 1;
    }
    const end = findClosingBraces(source, exprStart);
    if (end < 0) {
      throw new Error('unclosed template action "{{"');
    }
    let exprEnd = end;
    let trimRight = false;
    if (exprEnd > exprStart && source[exprEnd - 1] === '-' && (source[exprEnd - 2] === ' ' || source[exprEnd - 2] === '\t' || source[exprEnd - 2] === '\n' || source[exprEnd - 2] === '\r')) {
      trimRight = true;
      exprEnd -= 1;
    }
    tokens.push({
      kind: 'action',
      value: source.slice(exprStart, exprEnd).trim(),
      trimLeft,
      trimRight,
    });
    cursor = end + 2;
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind !== 'action') continue;
    if (tok.trimLeft && i > 0 && tokens[i - 1]!.kind === 'text') {
      tokens[i - 1] = { kind: 'text', value: tokens[i - 1]!.value.replace(/[ \t\r\n]+$/, '') };
    }
    if (tok.trimRight && i + 1 < tokens.length && tokens[i + 1]!.kind === 'text') {
      tokens[i + 1] = { kind: 'text', value: tokens[i + 1]!.value.replace(/^[ \t\r\n]+/, '') };
    }
  }
  return tokens;
}

function findClosingBraces(source: string, from: number): number {
  let inQuote = false;
  let escaped = false;
  for (let i = from; i < source.length - 1; i += 1) {
    const ch = source[i]!;
    if (inQuote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inQuote = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (ch === '}' && source[i + 1] === '}') {
      return i;
    }
  }
  return -1;
}

function splitPipeline(expr: string): string[] {
  const stages: string[] = [];
  let inQuote = false;
  let escaped = false;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i]!;
    if (inQuote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) throw new Error('unbalanced parentheses in template');
    } else if (ch === '|' && depth === 0) {
      const stage = expr.slice(start, i).trim();
      if (stage === '') throw new Error('empty pipeline stage in template');
      stages.push(stage);
      start = i + 1;
    }
  }
  if (inQuote || depth !== 0) throw new Error('unterminated expression in template');
  const tail = expr.slice(start).trim();
  if (tail === '') throw new Error('empty expression in template');
  stages.push(tail);
  return stages;
}

function splitArgs(command: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i]!)) i += 1;
    if (i >= command.length) break;
    if (command[i] === '"') {
      let j = i + 1;
      let esc = false;
      while (j < command.length) {
        if (esc) esc = false;
        else if (command[j] === '\\') esc = true;
        else if (command[j] === '"') break;
        j += 1;
      }
      if (j >= command.length) throw new Error('unterminated string literal in template');
      args.push(command.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (command[i] === '(') {
      let depth = 0;
      let inQ = false;
      let esc = false;
      let j = i;
      while (j < command.length) {
        const ch = command[j]!;
        if (inQ) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inQ = false;
        } else if (ch === '"') {
          inQ = true;
        } else if (ch === '(') {
          depth += 1;
        } else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
        j += 1;
      }
      if (depth !== 0) throw new Error('unbalanced parentheses in template');
      while (j < command.length && !/\s/.test(command[j]!)) j += 1;
      args.push(command.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < command.length && !/\s/.test(command[j]!)) j += 1;
    args.push(command.slice(i, j));
    i = j;
  }
  return args;
}

function validateTermSyntax(term: string): void {
  if (term === '.' || term === 'true' || term === 'false' || term === 'nil') return;
  if (/^-?\d+$/.test(term)) return;
  if (term.startsWith('"') && term.endsWith('"')) {
    JSON.parse(term);
    return;
  }
  if (term.startsWith('(')) {
    const close = findBalancedParenEnd(term);
    if (close < 0) throw new Error('unbalanced parentheses in template');
    const inner = term.slice(1, close).trim();
    const rest = term.slice(close + 1).trim();
    if (inner === '') throw new Error('empty subexpression in template');
    for (const stage of splitPipeline(inner)) {
      for (const arg of splitArgs(stage)) validateTermSyntax(arg);
    }
    if (rest !== '') {
      if (!rest.startsWith('.') || rest.endsWith('.')) {
        throw new Error(`invalid field suffix "${rest}" in template`);
      }
    }
    return;
  }
  if (term.startsWith('.') || term.startsWith('$')) {
    if (term.endsWith('.')) throw new Error(`unexpected trailing dot in "${term}"`);
    return;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(term)) {
    if (!ALLOWED_FUNCS.has(term)) {
      throw new Error(`unsupported template function "${term}"`);
    }
    return;
  }
  throw new Error(`invalid template token "${term}"`);
}

function findBalancedParenEnd(term: string): number {
  let depth = 0;
  let inQ = false;
  let esc = false;
  for (let i = 0; i < term.length; i += 1) {
    const ch = term[i]!;
    if (inQ) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inQ = false;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseNodes(
  tokens: readonly RawToken[],
  state: { idx: number },
  stopAt: readonly string[],
): { readonly nodes: TemplateNode[]; readonly stopTag?: string } {
  const nodes: TemplateNode[] = [];
  while (state.idx < tokens.length) {
    const tok = tokens[state.idx]!;
    if (tok.kind === 'text') {
      state.idx += 1;
      if (tok.value !== '') nodes.push({ kind: 'text', value: tok.value });
      continue;
    }
    const action = tok.value;
    if (stopAt.includes(action)) {
      state.idx += 1;
      return { nodes, stopTag: action };
    }
    state.idx += 1;
    if (action === '') throw new Error('empty template action');
    if (action.startsWith('range ')) {
      const clause = action.slice('range '.length).trim();
      const assignIdx = clause.indexOf(':=');
      let idxVar: string | undefined;
      let valVar: string | undefined;
      let expr = clause;
      if (assignIdx >= 0) {
        const lhs = clause.slice(0, assignIdx).trim();
        expr = clause.slice(assignIdx + 2).trim();
        const vars = lhs.split(',').map((s) => s.trim());
        if (vars.length === 1) {
          valVar = vars[0];
        } else if (vars.length === 2) {
          idxVar = vars[0];
          valVar = vars[1];
        } else {
          throw new Error('invalid range variables in template');
        }
      }
      for (const arg of splitArgs(expr)) validateTermSyntax(arg);
      const bodyRes = parseNodes(tokens, state, ['else', 'end']);
      let elseBody: readonly TemplateNode[] = [];
      if (bodyRes.stopTag === 'else') {
        const elseRes = parseNodes(tokens, state, ['end']);
        if (elseRes.stopTag !== 'end') throw new Error('missing {{end}} for {{range}}');
        elseBody = elseRes.nodes;
      } else if (bodyRes.stopTag !== 'end') {
        throw new Error('missing {{end}} for {{range}}');
      }
      nodes.push({ kind: 'range', idxVar, valVar, expr, body: bodyRes.nodes, elseBody });
      continue;
    }
    if (action.startsWith('if ')) {
      const expr = action.slice('if '.length).trim();
      for (const arg of splitArgs(expr)) validateTermSyntax(arg);
      const bodyRes = parseNodes(tokens, state, ['else', 'end']);
      let elseBody: readonly TemplateNode[] = [];
      if (bodyRes.stopTag === 'else') {
        const elseRes = parseNodes(tokens, state, ['end']);
        if (elseRes.stopTag !== 'end') throw new Error('missing {{end}} for {{if}}');
        elseBody = elseRes.nodes;
      } else if (bodyRes.stopTag !== 'end') {
        throw new Error('missing {{end}} for {{if}}');
      }
      nodes.push({ kind: 'if', expr, body: bodyRes.nodes, elseBody });
      continue;
    }
    if (action === 'end' || action === 'else') {
      throw new Error(`unexpected {{${action}}}`);
    }
    const pipeline = splitPipeline(action);
    for (const stage of pipeline) {
      const args = splitArgs(stage);
      for (const arg of args) validateTermSyntax(arg);
    }
    nodes.push({ kind: 'eval', pipeline });
  }
  if (stopAt.length > 0) {
    throw new Error(`unexpected EOF waiting for ${stopAt.join(' or ')}`);
  }
  return { nodes };
}

export function parseWebhookTemplate(source: string): readonly TemplateNode[] {
  const tokens = tokenizeTemplate(source);
  const { nodes } = parseNodes(tokens, { idx: 0 }, []);
  return nodes;
}

interface EvalScope {
  readonly dot: unknown;
  readonly vars: Readonly<Record<string, unknown>>;
}

function readOwnField(target: unknown, key: string): unknown {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new Error(`unknown template field ".${key}"`);
  }
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    throw new Error(`cannot evaluate field ".${key}" on non-object value`);
  }
  const record = target as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new Error(`unknown template field ".${key}"`);
  }
  return record[key];
}

function resolveFieldPath(base: unknown, pathAfterDot: string): unknown {
  const parts = pathAfterDot.split('.');
  let current = base;
  for (const part of parts) {
    current = readOwnField(current, part);
  }
  return current;
}

function stringifyTemplateValue(val: unknown): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
    return String(val);
  }
  return JSON.stringify(val);
}

function formatPrintf(fmt: string, args: readonly unknown[]): string {
  let argIdx = 0;
  return fmt.replaceAll(/%([sdfv%])/g, (_match, spec: string) => {
    if (spec === '%') return '%';
    return stringifyTemplateValue(args[argIdx++]);
  });
}

function evalTerm(term: string, scope: EvalScope, pipeInput?: unknown, hasPipeInput = false): unknown {
  if (term === '.') return scope.dot;
  if (term === 'true') return true;
  if (term === 'false') return false;
  if (term === 'nil') return null;
  if (/^-?\d+$/.test(term)) return Number.parseInt(term, 10);
  if (term.startsWith('"') && term.endsWith('"')) return JSON.parse(term) as string;
  if (term.startsWith('(')) {
    const close = findBalancedParenEnd(term);
    const inner = term.slice(1, close).trim();
    const suffix = term.slice(close + 1).trim();
    let val = evalPipeline(splitPipeline(inner), scope);
    if (suffix !== '') {
      val = resolveFieldPath(val, suffix.slice(1));
    }
    return val;
  }
  if (term.startsWith('$')) {
    const dotIdx = term.indexOf('.');
    if (dotIdx < 0) {
      if (!Object.prototype.hasOwnProperty.call(scope.vars, term)) {
        throw new Error(`undefined template variable "${term}"`);
      }
      return scope.vars[term];
    }
    const varName = term.slice(0, dotIdx);
    if (!Object.prototype.hasOwnProperty.call(scope.vars, varName)) {
      throw new Error(`undefined template variable "${varName}"`);
    }
    return resolveFieldPath(scope.vars[varName], term.slice(dotIdx + 1));
  }
  if (term.startsWith('.')) {
    return resolveFieldPath(scope.dot, term.slice(1));
  }
  if (hasPipeInput) {
    return callTemplateFunc(term, [pipeInput]);
  }
  return callTemplateFunc(term, []);
}

function callTemplateFunc(name: string, args: readonly unknown[]): unknown {
  switch (name) {
    case 'json':
      if (args.length !== 1) throw new Error('json requires 1 argument');
      return JSON.stringify(args[0]);
    case 'jsons': {
      if (args.length !== 1) throw new Error('jsons requires 1 argument');
      const raw = JSON.stringify(args[0]);
      const quoted = JSON.stringify(raw);
      return quoted.slice(1, -1);
    }
    case 'printf': {
      if (args.length === 0 || typeof args[0] !== 'string') {
        throw new Error('printf requires a format string');
      }
      return formatPrintf(args[0], args.slice(1));
    }
    case 'index': {
      if (args.length < 2) throw new Error('index requires at least 2 arguments');
      let current: unknown = args[0];
      for (const idx of args.slice(1)) {
        if (Array.isArray(current) && typeof idx === 'number') {
          current = current[idx];
        } else if (typeof current === 'object' && current !== null && typeof idx === 'string') {
          current = readOwnField(current, idx);
        } else {
          throw new Error('invalid index target');
        }
      }
      return current;
    }
    default:
      throw new Error(`unsupported template function "${name}"`);
  }
}

function evalStage(stage: string, scope: EvalScope, pipeInput?: unknown, hasPipeInput = false): unknown {
  const parts = splitArgs(stage);
  if (parts.length === 0) throw new Error('empty template command');
  const head = parts[0]!;
  if (ALLOWED_FUNCS.has(head)) {
    const evaluatedArgs = parts.slice(1).map((arg) => evalTerm(arg, scope));
    if (hasPipeInput) evaluatedArgs.push(pipeInput);
    return callTemplateFunc(head, evaluatedArgs);
  }
  if (parts.length === 1) {
    return evalTerm(head, scope, pipeInput, hasPipeInput);
  }
  throw new Error(`unexpected arguments for "${head}"`);
}

function evalPipeline(pipeline: readonly string[], scope: EvalScope): unknown {
  let hasInput = false;
  let value: unknown;
  for (const stage of pipeline) {
    value = evalStage(stage, scope, value, hasInput);
    hasInput = true;
  }
  return value;
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '') {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function evalNodes(nodes: readonly TemplateNode[], scope: EvalScope): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.value;
        break;
      case 'eval': {
        const val = evalPipeline(node.pipeline, scope);
        out += stringifyTemplateValue(val);
        break;
      }
      case 'if': {
        const cond = evalPipeline(splitPipeline(node.expr), scope);
        out += evalNodes(isTruthy(cond) ? node.body : node.elseBody, scope);
        break;
      }
      case 'range': {
        const collection = evalPipeline(splitPipeline(node.expr), scope);
        if (!Array.isArray(collection) || collection.length === 0) {
          out += evalNodes(node.elseBody, scope);
          break;
        }
        for (let i = 0; i < collection.length; i += 1) {
          const item = collection[i];
          const nextVars: Record<string, unknown> = { ...scope.vars };
          if (node.idxVar !== undefined) nextVars[node.idxVar] = i;
          if (node.valVar !== undefined) nextVars[node.valVar] = item;
          out += evalNodes(node.body, { dot: item, vars: nextVars });
        }
        break;
      }
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  }
  return out;
}

export function renderWebhookBody(
  template: string,
  message: NotifyMessage,
  nowMs: number = Date.now(),
): string {
  if (template.trim() === '') {
    return JSON.stringify(buildDefaultWebhookPayload(message));
  }
  const ast = parseWebhookTemplate(template);
  const data = buildWebhookTemplateData(message, nowMs);
  return evalNodes(ast, { dot: data, vars: { $: data } });
}

export const webhookChannel: NotifyChannel = {
  kind: 'webhook',

  defaultRatePerMin(): number {
    return 0;
  },

  secretKeys(): readonly string[] {
    return ['url', 'headers'];
  },

  destinationKeys(): readonly string[] {
    return ['url'];
  },

  validate(cfg: Readonly<Record<string, unknown>>, options?: NotifyTransportOptions): void {
    const rawUrl = cfgString(cfg, 'url');
    if (rawUrl === '') {
      throw new Error('missing target URL');
    }
    try {
      validateHttpUrl(rawUrl, options);
    } catch (error) {
      throw new Error(
        `invalid target URL: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const method = cfgString(cfg, 'method').toUpperCase();
    if (method !== '' && !ALLOWED_METHODS.has(method)) {
      throw new Error(`unsupported method ${method} (allowed: GET/POST/PUT/PATCH)`);
    }
    const tpl = cfgString(cfg, 'body_template');
    if (tpl !== '') {
      try {
        parseWebhookTemplate(tpl);
      } catch (error) {
        throw new Error(
          `body template syntax error: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  },

  async send(
    cfg: Readonly<Record<string, unknown>>,
    message: NotifyMessage,
    options?: NotifyTransportOptions,
  ): Promise<number> {
    try {
      this.validate(cfg, options);
    } catch (error) {
      throw permanentError(error);
    }

    const method = cfgString(cfg, 'method').toUpperCase() || 'POST';
    let preSerializedJson: string | undefined;
    if (method !== 'GET') {
      let body: string;
      try {
        body = renderWebhookBody(
          cfgString(cfg, 'body_template'),
          message,
          options?.nowMs ? options.nowMs() : Date.now(),
        );
      } catch (error) {
        throw permanentError(error);
      }
      try {
        JSON.parse(body);
      } catch {
        throw permanentError('body template did not render valid JSON');
      }
      preSerializedJson = body;
    }

    const headers: Record<string, string> = { ...cfgMap(cfg, 'headers') };
    const ct = cfgString(cfg, 'content_type');
    if (ct !== '') {
      headers['Content-Type'] = ct;
    }

    await doHttpJson(method, cfgString(cfg, 'url'), headers, undefined, {
      ...options,
      preSerializedJson,
    });
    return message.items.length;
  },
};

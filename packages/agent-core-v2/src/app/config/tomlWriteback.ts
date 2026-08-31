import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { deepEqual, isPlainObject } from './configPure';

export interface DomainUpdate {
  readonly snakeKey: string;
  readonly previousValue: unknown;
  readonly nextValue: unknown;
}

type LineEdit =
  | {
      readonly type: 'replace';
      readonly startLine: number;
      readonly endLine: number;
      readonly text: string;
    }
  | { readonly type: 'insert'; readonly afterLine: number; readonly text: string };

interface RootRegion {
  readonly rootKey: string;
  start: number;
  end: number;
  dotted: boolean;
}

type RootSegment =
  | { readonly kind: 'trivia'; readonly start: number; readonly end: number }
  | { readonly kind: 'region'; readonly region: RootRegion };

interface DomainStatement {
  readonly key: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly indent: string;
  readonly separator: string;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface DomainBlock {
  readonly path: readonly string[];
  readonly hasHeader: boolean;
  readonly isArray: boolean;
  readonly startLine: number;
  endLine: number;
  readonly statements: DomainStatement[];
}

interface DomainScan {
  readonly blocks: readonly DomainBlock[];
  readonly ambiguous: boolean;
}

interface KeyValueMatch {
  readonly indent: string;
  readonly keySegments: readonly string[];
  readonly dotted: boolean;
  readonly separator: string;
  readonly valueStart: number;
}

interface HeaderMatch {
  readonly rootKey: string;
  readonly path: readonly string[];
  readonly isArray: boolean;
}

const KEY_VALUE_LINE_PATTERN = /^(\s*)([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)(\s*=\s*)([\s\S]*)$/;
const BARE_KEY_CHAR_PATTERN = /[A-Za-z0-9_-]/;

function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function stripLineEnding(line: string): string {
  if (!line.endsWith('\n')) return line;
  return line.endsWith('\r\n') ? line.slice(0, -2) : line.slice(0, -1);
}

function detectEol(text: string): string {
  const index = text.indexOf('\n');
  return index > 0 && text.charAt(index - 1) === '\r' ? '\r\n' : '\n';
}

function isTriviaBody(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

function lineIndexAt(offsets: readonly number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  let result = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid]! <= position) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

function lineStartOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
  }
  return offsets;
}

function scanStringEnd(text: string, offset: number): number | undefined {
  const quote = text.charAt(offset);
  if (text.startsWith(quote + quote + quote, offset)) {
    let i = offset + 3;
    while (i < text.length) {
      if (quote === '"' && text.charAt(i) === '\\') {
        i += 2;
        continue;
      }
      if (text.charAt(i) === quote) {
        let run = 0;
        while (i + run < text.length && text.charAt(i + run) === quote) run++;
        if (run >= 3) return i + run;
        i += run;
        continue;
      }
      i++;
    }
    return undefined;
  }
  let i = offset + 1;
  while (i < text.length) {
    if (text.charAt(i) === '\n') return undefined;
    if (quote === '"' && text.charAt(i) === '\\') {
      i += 2;
      continue;
    }
    if (text.charAt(i) === quote) return i + 1;
    i++;
  }
  return undefined;
}

function scanBalanced(text: string, offset: number, open: string, close: string): number | undefined {
  let depth = 0;
  let i = offset;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'") {
      const end = scanStringEnd(text, i);
      if (end === undefined) return undefined;
      i = end;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    } else if (ch === '\n' && open === '{') {
      return undefined;
    }
    i++;
  }
  return undefined;
}

function scanValueEnd(text: string, offset: number): number | undefined {
  const first = text.charAt(offset);
  if (first === '"' || first === "'") return scanStringEnd(text, offset);
  if (first === '[') return scanBalanced(text, offset, '[', ']');
  if (first === '{') return scanBalanced(text, offset, '{', '}');
  let i = offset;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '#') break;
    i++;
  }
  return i === offset ? undefined : i;
}

function decodeBasicEscape(body: string, offset: number): { char: string; end: number } | undefined {
  const code = body.charAt(offset + 1);
  switch (code) {
    case 'b':
      return { char: '\b', end: offset + 2 };
    case 't':
      return { char: '\t', end: offset + 2 };
    case 'n':
      return { char: '\n', end: offset + 2 };
    case 'f':
      return { char: '\f', end: offset + 2 };
    case 'r':
      return { char: '\r', end: offset + 2 };
    case '"':
      return { char: '"', end: offset + 2 };
    case '\\':
      return { char: '\\', end: offset + 2 };
    case 'u':
      return decodeUnicodeEscape(body, offset, 4);
    case 'U':
      return decodeUnicodeEscape(body, offset, 8);
    default:
      return undefined;
  }
}

function decodeUnicodeEscape(
  body: string,
  offset: number,
  digits: number,
): { char: string; end: number } | undefined {
  const hex = body.slice(offset + 2, offset + 2 + digits);
  if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  const codePoint = Number.parseInt(hex, 16);
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
  return { char: String.fromCodePoint(codePoint), end: offset + 2 + digits };
}

function skipInlineWhitespace(body: string, offset: number): number {
  let i = offset;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch !== ' ' && ch !== '\t') break;
    i++;
  }
  return i;
}

interface HeaderSegment {
  readonly value: string;
  readonly end: number;
}

function scanBasicHeaderSegment(body: string, offset: number): HeaderSegment | undefined {
  let i = offset + 1;
  let value = '';
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch === '"') {
      if (value.length === 0) return undefined;
      return { value, end: i + 1 };
    }
    if (ch === '\\') {
      const escape = decodeBasicEscape(body, i);
      if (escape === undefined) return undefined;
      value += escape.char;
      i = escape.end;
      continue;
    }
    value += ch;
    i++;
  }
  return undefined;
}

function scanLiteralHeaderSegment(body: string, offset: number): HeaderSegment | undefined {
  const close = body.indexOf("'", offset + 1);
  if (close === -1) return undefined;
  const value = body.slice(offset + 1, close);
  if (value.length === 0) return undefined;
  return { value, end: close + 1 };
}

function scanHeaderSegment(body: string, offset: number): HeaderSegment | undefined {
  const start = skipInlineWhitespace(body, offset);
  const ch = body.charAt(start);
  if (ch === '"') return scanBasicHeaderSegment(body, start);
  if (ch === "'") return scanLiteralHeaderSegment(body, start);
  let i = start;
  while (i < body.length && BARE_KEY_CHAR_PATTERN.test(body.charAt(i))) i++;
  if (i === start) return undefined;
  return { value: body.slice(start, i), end: i };
}

function matchHeader(body: string): HeaderMatch | undefined {
  const start = skipInlineWhitespace(body, 0);
  let isArray = false;
  let i: number;
  if (body.startsWith('[[', start)) {
    isArray = true;
    i = start + 2;
  } else if (body.charAt(start) === '[') {
    i = start + 1;
  } else {
    return undefined;
  }
  const path: string[] = [];
  for (;;) {
    const segment = scanHeaderSegment(body, i);
    if (segment === undefined) return undefined;
    path.push(segment.value);
    i = skipInlineWhitespace(body, segment.end);
    const ch = body.charAt(i);
    if (ch === ']') {
      i++;
      break;
    }
    if (ch !== '.') return undefined;
    i = skipInlineWhitespace(body, i + 1);
  }
  if (isArray) {
    if (body.charAt(i) !== ']') return undefined;
    i++;
  }
  const rest = skipInlineWhitespace(body, i);
  if (rest < body.length && body.charAt(rest) !== '#') return undefined;
  return { rootKey: path[0]!, path, isArray };
}

function matchKeyValue(body: string): KeyValueMatch | undefined {
  const match = KEY_VALUE_LINE_PATTERN.exec(body);
  if (match === null) return undefined;
  const keySegments = match[2]!.split('.');
  return {
    indent: match[1]!,
    keySegments,
    dotted: keySegments.length > 1,
    separator: match[3]!,
    valueStart: body.length - match[4]!.length,
  };
}

interface ScannedDocument {
  lines: string[];
  offsets: number[];
  eol: string;
  segments: RootSegment[];
}

function scanRootRegions(text: string): ScannedDocument | undefined {
  const lines = splitLinesKeepEnds(text);
  const offsets = lineStartOffsets(lines);
  const eol = detectEol(text);
  const segments: RootSegment[] = [];
  let region: RootRegion | undefined;
  let triviaStart = -1;
  let i = 0;
  while (i < lines.length) {
    const body = stripLineEnding(lines[i]!);
    if (isTriviaBody(body)) {
      if (triviaStart < 0) triviaStart = i;
      i++;
      continue;
    }
    if (triviaStart >= 0) {
      segments.push({ kind: 'trivia', start: triviaStart, end: i - 1 });
      triviaStart = -1;
    }
    const header = matchHeader(body);
    if (header !== undefined) {
      if (region === undefined || region.rootKey !== header.rootKey) {
        if (region !== undefined) segments.push({ kind: 'region', region });
        region = { rootKey: header.rootKey, start: i, end: i, dotted: false };
      } else {
        region.end = i;
      }
      i++;
      continue;
    }
    const kv = matchKeyValue(body);
    if (kv === undefined) return undefined;
    const valueStart = offsets[i]! + kv.valueStart;
    const valueEnd = scanValueEnd(text, valueStart);
    if (valueEnd === undefined) return undefined;
    const endLine = lineIndexAt(offsets, valueEnd - 1);
    const rootKey = region === undefined ? kv.keySegments[0]! : region.rootKey;
    if (region === undefined || region.rootKey !== rootKey) {
      if (region !== undefined) segments.push({ kind: 'region', region });
      region = { rootKey, start: i, end: endLine, dotted: kv.dotted };
    } else {
      region.end = endLine;
      region.dotted = region.dotted || kv.dotted;
    }
    i = endLine + 1;
  }
  if (triviaStart >= 0) segments.push({ kind: 'trivia', start: triviaStart, end: lines.length - 1 });
  if (region !== undefined) segments.push({ kind: 'region', region });
  return { lines, offsets, eol, segments };
}

function scanDomainRegion(
  text: string,
  lines: readonly string[],
  offsets: readonly number[],
  region: RootRegion,
  snakeKey: string,
): DomainScan | undefined {
  const blocks: DomainBlock[] = [];
  let ambiguous = false;
  let current: DomainBlock | undefined;
  for (let i = region.start; i <= region.end; i++) {
    const body = stripLineEnding(lines[i]!);
    if (isTriviaBody(body)) continue;
    const header = matchHeader(body);
    if (header !== undefined) {
      if (header.rootKey !== snakeKey) return undefined;
      current = {
        path: header.path.slice(1),
        hasHeader: true,
        isArray: header.isArray,
        startLine: i,
        endLine: i,
        statements: [],
      };
      if (header.isArray) ambiguous = true;
      blocks.push(current);
      continue;
    }
    const kv = matchKeyValue(body);
    if (kv === undefined) return undefined;
    if (kv.dotted) ambiguous = true;
    const valueStart = offsets[i]! + kv.valueStart;
    const valueEnd = scanValueEnd(text, valueStart);
    if (valueEnd === undefined) return undefined;
    const endLine = lineIndexAt(offsets, valueEnd - 1);
    const statement: DomainStatement = {
      key: kv.keySegments.at(-1)!,
      startLine: i,
      endLine,
      indent: kv.indent,
      separator: kv.separator,
      valueStart,
      valueEnd,
    };
    if (current === undefined) {
      current = {
        path: [],
        hasHeader: false,
        isArray: false,
        startLine: i,
        endLine,
        statements: [statement],
      };
      blocks.push(current);
    } else {
      current.statements.push(statement);
      current.endLine = endLine;
    }
    i = endLine;
  }
  return { blocks, ambiguous };
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function blocksNestedUnder(blocks: readonly DomainBlock[], path: readonly string[]): readonly DomainBlock[] {
  return blocks.filter(
    (block) => block.path.length >= path.length && pathsEqual(block.path.slice(0, path.length), path),
  );
}

function removeLines(startLine: number, endLine: number): LineEdit {
  return { type: 'replace', startLine, endLine, text: '' };
}

function insertMerged(edits: LineEdit[], afterLine: number, text: string): void {
  const existing = edits.find((edit) => edit.type === 'insert' && edit.afterLine === afterLine);
  if (existing !== undefined && existing.type === 'insert') {
    edits.splice(edits.indexOf(existing), 1, { ...existing, text: existing.text + text });
    return;
  }
  edits.push({ type: 'insert', afterLine, text });
}

function statementSuffix(text: string, statement: DomainStatement): string {
  const lineEnd = text.indexOf('\n', statement.valueEnd);
  const end = lineEnd === -1 ? text.length : lineEnd;
  return text.slice(statement.valueEnd, end).replace(/\r$/, '');
}

function renderStatement(text: string, statement: DomainStatement, valueText: string, eol: string): string {
  const suffix = statementSuffix(text, statement);
  const rendered = `${statement.indent}${statement.key}${statement.separator}${valueText}${suffix}`;
  return rendered.endsWith('\n') ? rendered : `${rendered}${eol}`;
}

function serializeValueText(key: string, value: unknown): string | undefined {
  const prefix = `${key} = `;
  const serialized = stringifyToml({ [key]: value });
  if (!serialized.startsWith(prefix)) return undefined;
  const text = serialized.slice(prefix.length);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function serializeTableBlock(path: readonly string[], value: unknown, eol: string): string {
  let nested: unknown = value;
  for (let i = path.length - 1; i >= 0; i--) {
    nested = { [path[i]!]: nested };
  }
  return stringifyToml(nested as Record<string, unknown>).replaceAll('\n', eol);
}

function blockAnchorLine(block: DomainBlock): number {
  const last = block.statements.at(-1);
  return last === undefined ? block.startLine : last.endLine;
}

function planScalarDomainEdit(
  text: string,
  scan: DomainScan,
  update: DomainUpdate,
  eol: string,
): LineEdit[] | undefined {
  const block = scan.blocks[0];
  if (
    block === undefined ||
    scan.blocks.length !== 1 ||
    block.hasHeader ||
    block.path.length > 0 ||
    block.statements.length !== 1
  ) {
    return undefined;
  }
  const statement = block.statements[0]!;
  if (statement.key !== update.snakeKey) return undefined;
  const valueText = serializeValueText(statement.key, update.nextValue);
  if (valueText === undefined) return undefined;
  return [
    {
      type: 'replace',
      startLine: statement.startLine,
      endLine: statement.endLine,
      text: renderStatement(text, statement, valueText, eol),
    },
  ];
}

function planObjectLevel(
  text: string,
  rootKey: string,
  blocks: readonly DomainBlock[],
  prefix: readonly string[],
  previousValue: Record<string, unknown>,
  nextValue: Record<string, unknown>,
  edits: LineEdit[],
  appends: string[],
  eol: string,
): boolean {
  const block = blocks.find((candidate) => pathsEqual(candidate.path, prefix));
  const keys = [...new Set([...Object.keys(previousValue), ...Object.keys(nextValue)])];
  for (const key of keys) {
    const previous = previousValue[key];
    const next = nextValue[key];
    if (deepEqual(previous, next)) continue;
    const childPath = [...prefix, key];
    const statement = block?.statements.find((candidate) => candidate.key === key);
    const childBlock = blocks.find((candidate) => pathsEqual(candidate.path, childPath));
    if (statement !== undefined && childBlock !== undefined) return false;
    if (next === undefined) {
      if (childBlock !== undefined) {
        if (childBlock.isArray) return false;
        for (const nested of blocksNestedUnder(blocks, childPath)) {
          edits.push(removeLines(nested.startLine, nested.endLine));
        }
        continue;
      }
      if (statement === undefined) return false;
      edits.push(removeLines(statement.startLine, statement.endLine));
      continue;
    }
    if (previous === undefined) {
      if (isPlainObject(next)) {
        appends.push(serializeTableBlock([rootKey, ...childPath], next, eol));
      } else {
        const valueText = serializeValueText(key, next);
        if (valueText === undefined) return false;
        if (block !== undefined) {
          insertMerged(edits, blockAnchorLine(block), `${key} = ${valueText}${eol}`);
        } else {
          appends.push(serializeTableBlock([rootKey, ...prefix], { [key]: next }, eol));
        }
      }
      continue;
    }
    if (isPlainObject(previous) && isPlainObject(next)) {
      if (statement !== undefined || childBlock === undefined || childBlock.isArray) return false;
      if (!planObjectLevel(text, rootKey, blocks, childPath, previous, next, edits, appends, eol)) {
        return false;
      }
      continue;
    }
    if (isPlainObject(next)) {
      if (statement === undefined) return false;
      edits.push(removeLines(statement.startLine, statement.endLine));
      appends.push(serializeTableBlock([rootKey, ...childPath], next, eol));
      continue;
    }
    if (isPlainObject(previous)) {
      if (childBlock === undefined || childBlock.isArray) return false;
      for (const nested of blocksNestedUnder(blocks, childPath)) {
        edits.push(removeLines(nested.startLine, nested.endLine));
      }
      const valueText = serializeValueText(key, next);
      if (valueText === undefined) return false;
      if (block !== undefined) {
        insertMerged(edits, blockAnchorLine(block), `${key} = ${valueText}${eol}`);
      } else {
        appends.push(serializeTableBlock([rootKey, ...prefix], { [key]: next }, eol));
      }
      continue;
    }
    if (statement === undefined) return false;
    const valueText = serializeValueText(key, next);
    if (valueText === undefined) return false;
    edits.push({
      type: 'replace',
      startLine: statement.startLine,
      endLine: statement.endLine,
      text: renderStatement(text, statement, valueText, eol),
    });
  }
  return true;
}

function planDomainKeyEdit(
  text: string,
  scan: DomainScan,
  region: RootRegion,
  update: DomainUpdate,
  eol: string,
): LineEdit[] | undefined {
  if (scan.ambiguous) return undefined;
  const previousValue = update.previousValue;
  const nextValue = update.nextValue;
  if (!isPlainObject(previousValue) || !isPlainObject(nextValue)) {
    if (isPlainObject(previousValue) || isPlainObject(nextValue)) return undefined;
    return planScalarDomainEdit(text, scan, update, eol);
  }
  const edits: LineEdit[] = [];
  const appends: string[] = [];
  if (!planObjectLevel(text, update.snakeKey, scan.blocks, [], previousValue, nextValue, edits, appends, eol)) {
    return undefined;
  }
  if (appends.length > 0) {
    edits.push({ type: 'insert', afterLine: region.end, text: appends.join('') });
  }
  return edits;
}

function editPosition(edit: LineEdit): number {
  return edit.type === 'replace' ? edit.startLine : edit.afterLine + 0.5;
}

function applyLineEdits(lines: readonly string[], edits: readonly LineEdit[], eol: string): string {
  const ordered = edits.toSorted((a, b) => editPosition(b) - editPosition(a));
  const out = [...lines];
  for (const edit of ordered) {
    if (edit.type === 'replace') {
      out.splice(edit.startLine, edit.endLine - edit.startLine + 1, ...splitLinesKeepEnds(edit.text));
    } else {
      const prefix = edit.afterLine < out.length && !out[edit.afterLine]!.endsWith('\n') ? eol : '';
      out.splice(edit.afterLine + 1, 0, ...splitLinesKeepEnds(prefix + edit.text));
    }
  }
  return out.join('');
}

function verifyPlannedText(text: string, expected: Record<string, unknown>): boolean {
  if (text.trim().length === 0) return Object.keys(expected).length === 0;
  try {
    return deepEqual(parseToml(text), expected);
  } catch {
    return false;
  }
}

export function planConfigWriteback(
  originalText: string,
  updates: readonly DomainUpdate[],
  expected: Record<string, unknown>,
): string | undefined {
  const scanned = scanRootRegions(originalText);
  if (scanned === undefined) return undefined;
  const regionsByKey = new Map<string, RootRegion[]>();
  for (const segment of scanned.segments) {
    if (segment.kind !== 'region') continue;
    const list = regionsByKey.get(segment.region.rootKey);
    if (list === undefined) {
      regionsByKey.set(segment.region.rootKey, [segment.region]);
    } else {
      list.push(segment.region);
    }
  }
  const edits: LineEdit[] = [];
  const appends: string[] = [];
  for (const update of updates) {
    if (deepEqual(update.previousValue, update.nextValue)) continue;
    const regions = regionsByKey.get(update.snakeKey) ?? [];
    if (update.previousValue === undefined && regions.length > 0) return undefined;
    if (update.nextValue === undefined) {
      if (update.previousValue === undefined) continue;
      if (regions.length === 0) return undefined;
      for (const region of regions) edits.push(removeLines(region.start, region.end));
      continue;
    }
    if (regions.length === 0) {
      if (update.previousValue !== undefined) return undefined;
      appends.push(serializeTableBlock([update.snakeKey], update.nextValue, scanned.eol));
      continue;
    }
    const replacement = serializeTableBlock([update.snakeKey], update.nextValue, scanned.eol);
    if (regions.length > 1 || regions[0]!.dotted) {
      edits.push({
        type: 'replace',
        startLine: regions[0]!.start,
        endLine: regions[0]!.end,
        text: replacement,
      });
      for (const extra of regions.slice(1)) edits.push(removeLines(extra.start, extra.end));
      continue;
    }
    const region = regions[0]!;
    const scan = scanDomainRegion(originalText, scanned.lines, scanned.offsets, region, update.snakeKey);
    const planned =
      scan === undefined
        ? undefined
        : planDomainKeyEdit(originalText, scan, region, update, scanned.eol);
    if (planned === undefined) {
      edits.push({ type: 'replace', startLine: region.start, endLine: region.end, text: replacement });
      continue;
    }
    edits.push(...planned);
  }
  let text = applyLineEdits(scanned.lines, edits, scanned.eol);
  for (const block of appends) {
    if (text.length > 0 && !text.endsWith('\n')) text += scanned.eol;
    text += block;
  }
  if (!verifyPlannedText(text, expected)) return undefined;
  return text;
}

export function replaceThinkingEffortMax(originalText: string): string | undefined {
  const scanned = scanRootRegions(originalText);
  if (scanned === undefined) return undefined;
  const regions = scanned.segments.flatMap((segment) =>
    segment.kind === 'region' && segment.region.rootKey === 'thinking' ? [segment.region] : [],
  );
  const region = regions.length === 1 ? regions[0]! : undefined;
  if (region === undefined || region.dotted) return undefined;
  const scan = scanDomainRegion(originalText, scanned.lines, scanned.offsets, region, 'thinking');
  if (scan === undefined || scan.ambiguous) return undefined;
  const block = scan.blocks.find((candidate) => candidate.path.length === 0 && !candidate.isArray);
  const statement = block?.statements.find((candidate) => candidate.key === 'effort');
  if (block === undefined || statement === undefined) return undefined;
  if (originalText.slice(statement.valueStart, statement.valueEnd) !== '"max"') return undefined;
  return applyLineEdits(
    scanned.lines,
    [
      {
        type: 'replace',
        startLine: statement.startLine,
        endLine: statement.endLine,
        text: renderStatement(originalText, statement, '"high"', scanned.eol),
      },
    ],
    scanned.eol,
  );
}

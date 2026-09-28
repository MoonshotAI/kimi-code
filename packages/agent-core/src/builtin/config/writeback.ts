import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { deepEqual, isPlainObject } from './pure';

export interface ConfigWritebackUpdate {
  readonly key: string;
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

interface SectionStatement {
  readonly key: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly indent: string;
  readonly separator: string;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface SectionBlock {
  readonly path: readonly string[];
  readonly hasHeader: boolean;
  readonly isArray: boolean;
  readonly startLine: number;
  endLine: number;
  readonly statements: SectionStatement[];
}

interface SectionScan {
  readonly blocks: readonly SectionBlock[];
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
  const close = body.indexOf('"', offset + 1);
  if (close === -1) return undefined;
  const value = body.slice(offset + 1, close);
  if (value.length === 0) return undefined;
  return { value, end: close + 1 };
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
  regions: RootRegion[];
}

function scanRootRegions(text: string): ScannedDocument | undefined {
  const lines = splitLinesKeepEnds(text);
  const offsets = lineStartOffsets(lines);
  const eol = detectEol(text);
  const regions: RootRegion[] = [];
  let region: RootRegion | undefined;
  let i = 0;
  while (i < lines.length) {
    const body = stripLineEnding(lines[i]!);
    if (isTriviaBody(body)) {
      i++;
      continue;
    }
    const header = matchHeader(body);
    if (header !== undefined) {
      if (region === undefined || region.rootKey !== header.rootKey) {
        if (region !== undefined) regions.push(region);
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
      if (region !== undefined) regions.push(region);
      region = { rootKey, start: i, end: endLine, dotted: kv.dotted };
    } else {
      region.end = endLine;
      region.dotted = region.dotted || kv.dotted;
    }
    i = endLine + 1;
  }
  if (region !== undefined) regions.push(region);
  return { lines, offsets, eol, regions };
}

function scanSectionRegion(
  text: string,
  lines: readonly string[],
  offsets: readonly number[],
  region: RootRegion,
): SectionScan | undefined {
  const blocks: SectionBlock[] = [];
  let ambiguous = false;
  let current: SectionBlock | undefined;
  for (let i = region.start; i <= region.end; i++) {
    const body = stripLineEnding(lines[i]!);
    if (isTriviaBody(body)) continue;
    const header = matchHeader(body);
    if (header !== undefined) {
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
    const valueStart = offsets[i]! + kv.valueStart;
    const valueEnd = scanValueEnd(text, valueStart);
    if (valueEnd === undefined) return undefined;
    const endLine = lineIndexAt(offsets, valueEnd - 1);
    const statement: SectionStatement = {
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

function blocksNestedUnder(blocks: readonly SectionBlock[], path: readonly string[]): readonly SectionBlock[] {
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

function statementSuffix(text: string, statement: SectionStatement): string {
  const lineEnd = text.indexOf('\n', statement.valueEnd);
  const end = lineEnd === -1 ? text.length : lineEnd;
  return text.slice(statement.valueEnd, end).replace(/\r$/, '');
}

function renderStatement(text: string, statement: SectionStatement, valueText: string, eol: string): string {
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

function blockAnchorLine(block: SectionBlock): number {
  const last = block.statements.at(-1);
  return last === undefined ? block.startLine : last.endLine;
}

function planObjectLevel(
  text: string,
  rootKey: string,
  blocks: readonly SectionBlock[],
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
    if (next === undefined) {
      if (childBlock !== undefined) {
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

function planSectionKeyEdit(
  text: string,
  scan: SectionScan,
  region: RootRegion,
  update: ConfigWritebackUpdate,
  eol: string,
): LineEdit[] | undefined {
  if (scan.ambiguous) return undefined;
  const previousValue = update.previousValue;
  const nextValue = update.nextValue;
  if (!isPlainObject(previousValue) || !isPlainObject(nextValue)) {
    return undefined;
  }
  const edits: LineEdit[] = [];
  const appends: string[] = [];
  if (!planObjectLevel(text, update.key, scan.blocks, [], previousValue, nextValue, edits, appends, eol)) {
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
  updates: readonly ConfigWritebackUpdate[],
  expected: Record<string, unknown>,
): string | undefined {
  const scanned = scanRootRegions(originalText);
  if (scanned === undefined) return undefined;
  const regionsByKey = new Map<string, RootRegion[]>();
  for (const region of scanned.regions) {
    const list = regionsByKey.get(region.rootKey);
    if (list === undefined) {
      regionsByKey.set(region.rootKey, [region]);
    } else {
      list.push(region);
    }
  }
  const edits: LineEdit[] = [];
  const appends: string[] = [];
  for (const update of updates) {
    if (deepEqual(update.previousValue, update.nextValue)) continue;
    const regions = regionsByKey.get(update.key) ?? [];
    if (update.nextValue === undefined) {
      if (update.previousValue === undefined) continue;
      for (const region of regions) edits.push(removeLines(region.start, region.end));
      continue;
    }
    if (regions.length === 0) {
      appends.push(serializeTableBlock([update.key], update.nextValue, scanned.eol));
      continue;
    }
    if (regions.length > 1) return undefined;
    const region = regions[0]!;
    if (region.dotted) {
      edits.push({
        type: 'replace',
        startLine: region.start,
        endLine: region.end,
        text: serializeTableBlock([update.key], update.nextValue, scanned.eol),
      });
      continue;
    }
    const scan = scanSectionRegion(originalText, scanned.lines, scanned.offsets, region);
    const planned =
      scan === undefined
        ? undefined
        : planSectionKeyEdit(originalText, scan, region, update, scanned.eol);
    if (planned === undefined) {
      edits.push({
        type: 'replace',
        startLine: region.start,
        endLine: region.end,
        text: serializeTableBlock([update.key], update.nextValue, scanned.eol),
      });
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

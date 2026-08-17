/**
 * Generates `docs/wire-manifest.d.ts` — the single place to see every durable
 * wire record type declared as an `Event2` subclass (`static type` +
 * `static durable = true` + `static schema`).
 *
 * Two passes:
 *   1. Static scan of `src/**` maps each durable event type to the source file
 *      that declares it — the "owner" — and collects the migration chain from
 *      `src/wire/migration/v*.ts`.
 *   2. Runtime pass imports `src/index.ts` plus every event/state module found
 *      in the static pass ("import = register") and drains `EVENT2_REGISTRY`
 *      (type → class → schema) and `REPLAYABLE_STATE_KEYS` (folding states, blob
 *      codecs) exactly as the running process sees them.
 *
 * The output is a `.d.ts` — one payload declaration per record type, with a
 * `WirePayloadMap` from record type to declaration — using real TypeScript
 * type syntax for the sketches.
 *
 * Usage:
 *   pnpm --filter @moonshot-ai/agent-core-v2 gen:wire-manifest          # write the file
 *   pnpm --filter @moonshot-ai/agent-core-v2 gen:wire-manifest --check  # freshness check (CI-style)
 *
 * Freshness is also enforced by `test/wire/wireManifest.test.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EVENT2_REGISTRY } from '#/app/event/event2';

import {
  asJsonSchema,
  describeType,
  isRecord,
  resolveRef,
  toJsonSchema,
  truncate,
  type JsonSchema,
} from './lib/jsonSchema.mts';

const PKG = join(import.meta.dirname, '..');
const SRC = join(PKG, 'src');
export const MANIFEST_PATH = join(PKG, 'docs', 'wire-manifest.d.ts');

// ---------------------------------------------------------------------------
// Static pass — durable event type → owner file; migration chain
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

const TYPE_DECL_RE = /static\s+override\s+readonly\s+type\s*=\s*'([^']+)'/g;
const DURABLE_DECL_RE = /static\s+override\s+readonly\s+durable\s*=\s*true/;
const CLASS_DECL_RE = /class\s+(\w+)\s+extends\s+Event2/g;

/**
 * event type → owner file (relative to the package root), the files worth
 * importing for the runtime pass, the types statically declared durable
 * (the class window between one `type` declaration and the next carries
 * `durable = true`), and the event class name → type map (the class window
 * between one `class … extends Event2` declaration and the next carries one
 * `static type`).
 */
function scanEventDeclarations(): {
  owners: Map<string, string>;
  importFiles: string[];
  durableTypes: Set<string>;
  classTypes: Map<string, string>;
} {
  const owners = new Map<string, string>();
  const importFiles: string[] = [];
  const durableTypes = new Set<string>();
  const classTypes = new Map<string, string>();
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf-8');
    const matches = [...source.matchAll(TYPE_DECL_RE)];
    const hasStates = source.includes('.replayable(');
    if (matches.length > 0 || hasStates) importFiles.push(file);
    for (const [i, match] of matches.entries()) {
      const type = match[1];
      if (type === undefined) continue;
      owners.set(type, relative(PKG, file));
      const windowEnd = i + 1 < matches.length ? matches[i + 1]!.index : source.length;
      if (DURABLE_DECL_RE.test(source.slice(match.index, windowEnd))) durableTypes.add(type);
    }
    const classMatches = [...source.matchAll(CLASS_DECL_RE)];
    for (const [i, match] of classMatches.entries()) {
      const className = match[1];
      if (className === undefined) continue;
      const windowEnd = i + 1 < classMatches.length ? classMatches[i + 1]!.index : source.length;
      const typeMatch = /static\s+override\s+readonly\s+type\s*=\s*'([^']+)'/.exec(
        source.slice(match.index, windowEnd),
      );
      if (typeMatch?.[1] !== undefined) classTypes.set(className, typeMatch[1]);
    }
  }
  return { owners, importFiles, durableTypes, classTypes };
}

/** `1.0 -> 1.1 -> ...` chain read from the `src/wire/migration/v*.ts` files. */
function scanMigrationChain(): string {
  const dir = join(SRC, 'wire', 'migration');
  const pairs: { source: string; target: string }[] = [];
  for (const entry of readdirSync(dir)) {
    if (!/^v[\d.]+\.ts$/.test(entry)) continue;
    const source = readFileSync(join(dir, entry), 'utf-8');
    const sourceVersion = /sourceVersion:\s*'([^']+)'/.exec(source)?.[1];
    const targetVersion = /targetVersion:\s*'([^']+)'/.exec(source)?.[1];
    if (sourceVersion !== undefined && targetVersion !== undefined) {
      pairs.push({ source: sourceVersion, target: targetVersion });
    }
  }
  pairs.sort((a, b) => a.source.localeCompare(b.source, undefined, { numeric: true }));
  const chain = pairs.flatMap((p, i) => (i === 0 ? [p.source, p.target] : [p.target]));
  return chain.join(' -> ');
}

// ---------------------------------------------------------------------------
// Static pass — replayable state keys and their fold targets
// ---------------------------------------------------------------------------

interface ReplayableStateScan {
  readonly keyName: string;
  readonly constName: string;
  readonly undoable: boolean;
  readonly blobs: boolean;
  readonly foldClasses: string[];
}

const ON_FOLD_RE = /\.on\(\s*([A-Za-z_$][\w$]*)/g;
const KEY_ON_RE = /\b([A-Za-z_$][\w$]*)\.on\(\s*([A-Za-z_$][\w$]*)/g;
const PROTOCOL_EVENT_RE = /(?:appendMessage|applyCompaction|clear|undo):\s*([A-Za-z_$][\w$]*)/g;

/** Balanced-paren read of the argument list starting at the `(` after a chain method. */
function readCallArguments(text: string, parenIndex: number): string {
  let depth = 0;
  for (let i = parenIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(parenIndex + 1, i);
    }
  }
  return text.slice(parenIndex + 1);
}

/**
 * `readExpression` variant for `defineState(...)` chains: the fold bodies are
 * arbitrary code, where `<` / `>` are comparison operators as often as generic
 * brackets — only `()` `{}` `[]` delimit the statement reliably.
 */
function readChain(source: string, start: number): string {
  let depth = 0;
  const n = source.length;
  for (let i = start; i < n; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

function scanReplayableStates(): ReplayableStateScan[] {
  const states: ReplayableStateScan[] = [];
  const byConst = new Map<string, ReplayableStateScan>();
  const constChainRe =
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*defineState\(\s*'([^']+)'/g;
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf-8');
    if (!source.includes('.replayable(') && !source.includes('.on(')) continue;
    for (const match of source.matchAll(constChainRe)) {
      const constName = match[1];
      const keyName = match[2];
      if (constName === undefined || keyName === undefined) continue;
      const chain = readChain(source, source.indexOf('defineState', match.index));
      const replayableIndex = chain.indexOf('.replayable(');
      if (replayableIndex === -1) continue;
      const replayableArgs = readCallArguments(chain, replayableIndex + '.replayable'.length);
      const scan: ReplayableStateScan = {
        keyName,
        constName,
        undoable: chain.includes('.undoable('),
        blobs: /\bblobs\s*:/.test(replayableArgs),
        foldClasses: [...chain.matchAll(ON_FOLD_RE)].map((m) => m[1]!),
      };
      states.push(scan);
      byConst.set(constName, scan);
    }
  }
  // A key's fold vocabulary may grow outside its defining chain
  // (`otherKey.on(Event, …)` in a feature module).
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf-8');
    if (!source.includes('.on(')) continue;
    for (const match of source.matchAll(KEY_ON_RE)) {
      const scan = byConst.get(match[1]!);
      const cls = match[2];
      if (scan === undefined || cls === undefined) continue;
      if (!scan.foldClasses.includes(cls)) scan.foldClasses.push(cls);
    }
  }
  return states;
}

/** The four undoable-protocol event types, resolved through the class-name map. */
function scanUndoableProtocolTypes(classTypes: ReadonlyMap<string, string>): string[] {
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf-8');
    const index = source.indexOf('registerUndoableProtocol(');
    if (index === -1) continue;
    const window = readChain(source, index);
    const types: string[] = [];
    for (const match of window.matchAll(PROTOCOL_EVENT_RE)) {
      const cls = match[1]!;
      const type = classTypes.get(cls);
      if (type === undefined) {
        throw new Error(
          `[gen-wire-manifest] undoable protocol event class '${cls}' has no resolved type`,
        );
      }
      types.push(type);
    }
    return types;
  }
  throw new Error('[gen-wire-manifest] registerUndoableProtocol call not found under src/');
}

// ---------------------------------------------------------------------------
// Payload sketch
//
// A Sketch is a small tree: strings are one-line type annotations, dicts are
// object shapes, and a one-element array marks an array-of shape. The d.ts
// renderer below turns the tree into real TypeScript syntax.
// ---------------------------------------------------------------------------

type SketchDict = { [key: string]: Sketch };
type Sketch = string | SketchDict | [Sketch];

/** First key of a dict produced by expanding a named type. */
const TYPE_KEY = '_type';
/** Marker key rendered as a `// …` comment when a field list is capped. */
const MORE_KEY = '…';

/** Compact one-line rendering of a Sketch (used inside unions/intersections). */
function stringifySketch(sketch: Sketch): string {
  if (typeof sketch === 'string') return sketch;
  if (Array.isArray(sketch)) {
    const inner = stringifySketch(sketch[0]);
    return inner.includes('|') ? `(${inner})[]` : `${inner}[]`;
  }
  return `{ ${Object.entries(sketch)
    .map(([k, v]) => `${k}: ${stringifySketch(v)}`)
    .join(', ')} }`;
}

/** Build a Sketch tree from a zod JSON-schema projection. */
function sketchFromJsonSchema(schema: unknown, root: JsonSchema, depth: number): Sketch {
  const resolved = resolveRef(schema, root);
  const s = asJsonSchema(resolved);
  if (s !== undefined && depth < 4) {
    if (isRecord(s.properties) && Object.keys(s.properties).length > 0) {
      const required = new Set(Array.isArray(s.required) ? s.required : []);
      const dict: SketchDict = {};
      for (const [name, prop] of Object.entries(s.properties)) {
        dict[required.has(name) ? name : `${name}?`] = sketchFromJsonSchema(prop, root, depth + 1);
      }
      return dict;
    }
    if (s.type === 'array' && s.items !== undefined) {
      const inner = sketchFromJsonSchema(s.items, root, depth + 1);
      if (typeof inner !== 'string') return [inner];
    }
  }
  return describeType(resolved, tsQuote);
}

/** Build the payload Sketch tree for one op (all three data paths converge). */
function buildPayloadSketch(
  schema: unknown,
  staticSketch?: string | Map<string, Sketch>,
): Sketch {
  const jsonSchema = toJsonSchema(schema);
  if (jsonSchema === undefined) {
    if (typeof staticSketch === 'string') return staticSketch;
    if (staticSketch !== undefined && staticSketch.size > 0) {
      return Object.fromEntries(staticSketch);
    }
    return '(schema uses transforms; see the owner file)';
  }
  if (isRecord(jsonSchema.properties) && Object.keys(jsonSchema.properties).length > 0) {
    const required = new Set(Array.isArray(jsonSchema.required) ? jsonSchema.required : []);
    const dict: SketchDict = {};
    for (const [name, prop] of Object.entries(jsonSchema.properties)) {
      dict[required.has(name) ? name : `${name}?`] = sketchFromJsonSchema(prop, jsonSchema, 0);
    }
    return dict;
  }
  // An empty object schema (`z.object({})`) is a payload-less record.
  if (
    jsonSchema.type === 'object' &&
    (jsonSchema.additionalProperties === undefined || jsonSchema.additionalProperties === false)
  ) {
    return {};
  }
  return describeType(jsonSchema, tsQuote);
}

// ---------------------------------------------------------------------------
// d.ts rendering — Sketch tree → TypeScript declarations
// ---------------------------------------------------------------------------

function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => (part[0] ?? '').toUpperCase() + part.slice(1))
    .join('');
}

function tsFieldKey(key: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Convert a one-line sketch annotation into a valid TS type expression.
 * Returns the type plus an optional doc note (the expanded type's name, or a
 * hoisted shared spread that cannot be expressed inline).
 */
function sketchStringToTs(text: string): { type: string; doc?: string } {
  let t = text.trim();
  const docs: string[] = [];
  const named = /^([A-Z][$\w]*) = ([\s\S]+)$/.exec(t);
  if (named?.[1] !== undefined && named[2] !== undefined) {
    docs.push(named[1]);
    t = named[2].trim();
  }
  // A hoisted shared spread (`...base & A | B`) becomes a doc note + variants.
  const spread = /^((?:\.\.\.[$\w]+(?: \+ )?)+) & ([\s\S]+)$/.exec(t);
  if (spread?.[1] !== undefined && spread[2] !== undefined) {
    docs.push(`shared base: ${spread[1]}`);
    t = spread[2].trim();
  }
  t = t.replaceAll(/union on [$\w]+: /g, '');
  t = t.replaceAll(/\brecord</g, 'Record<');
  t = t.replaceAll(/\binteger\b/g, 'number');
  return { type: t, doc: docs.length > 0 ? docs.join(' · ') : undefined };
}

/**
 * Render a Sketch as TS type-expression lines. The first line continues after
 * the field's `key: `; subsequent lines carry `indent`.
 */
function renderTsType(sketch: Sketch, indent: string): { doc?: string; lines: string[] } {
  if (typeof sketch === 'string') {
    const { type, doc } = sketchStringToTs(sketch);
    return { doc, lines: [type] };
  }
  if (Array.isArray(sketch)) {
    const inner = renderTsType(sketch[0], indent);
    const lines = [...inner.lines];
    lines[lines.length - 1] += '[]';
    return { doc: inner.doc, lines };
  }
  const doc = typeof sketch[TYPE_KEY] === 'string' ? sketch[TYPE_KEY] : undefined;
  const lines = ['{'];
  emitTsDict(lines, sketch, indent + '  ');
  lines.push(`${indent}}`);
  return { doc, lines };
}

function emitTsDict(lines: string[], dict: SketchDict, indent: string): void {
  for (const [key, sketch] of Object.entries(dict)) {
    if (key === MORE_KEY) {
      lines.push(`${indent}// …`);
      continue;
    }
    if (key === TYPE_KEY) continue; // surfaces as the field's doc comment
    if (key.startsWith('...')) {
      lines.push(`${indent}// spread: ${key}`);
      continue;
    }
    const optional = key.endsWith('?');
    const fieldKey = tsFieldKey(optional ? key.slice(0, -1) : key);
    const { doc, lines: typeLines } = renderTsType(sketch, indent);
    if (doc !== undefined) lines.push(`${indent}/** ${doc} */`);
    lines.push(`${indent}${fieldKey}${optional ? '?' : ''}: ${typeLines[0]}${typeLines.length === 1 ? ';' : ''}`);
    if (typeLines.length > 1) {
      lines.push(...typeLines.slice(1, -1));
      lines.push(`${typeLines[typeLines.length - 1]};`);
    }
  }
}

/** One record type's payload declaration (`interface` for objects, `type` otherwise). */
function renderPayloadDecl(
  entry: { type: string },
  owner: string | undefined,
  states: string[],
  flags: string[],
  sketch: Sketch,
): string[] {
  const name = `${pascalCase(entry.type)}Payload`;
  const nameField = `_name: '${entry.type}';`;
  const header = [
    '/**',
    ` * states: ${states.length > 0 ? states.join(', ') : '(none)'}${flags.length > 0 ? ` · ${flags.join(' · ')}` : ''}`,
    ` * owner: ${owner ?? '(unresolved)'}`,
  ];
  if (typeof sketch === 'string') {
    const { type, doc } = sketchStringToTs(sketch);
    if (type.startsWith('(')) {
      // Unrepresentable schema note — keep the declaration parseable.
      header.push(` * ${type.slice(1, -1)}`);
      header.push(' */');
      return [...header, `interface ${name} {\n  ${nameField}\n}`, ''];
    }
    if (doc !== undefined) header.push(` * ${doc}`);
    header.push(' */');
    return [...header, `type ${name} = { ${nameField} } & (${type});`, ''];
  }
  if (Array.isArray(sketch)) {
    const inner = renderTsType(sketch[0], '  ');
    const lines = [...inner.lines];
    lines[lines.length - 1] += '[]';
    header.push(' */');
    if (lines.length === 1) {
      return [...header, `type ${name} = { ${nameField} } & (${lines[0]});`, ''];
    }
    return [
      ...header,
      `type ${name} = { ${nameField} } & (${lines[0]}`,
      ...lines.slice(1, -1),
      `${lines[lines.length - 1]});`,
      '',
    ];
  }
  const payloadType = typeof sketch[TYPE_KEY] === 'string' ? sketch[TYPE_KEY] : undefined;
  if (payloadType !== undefined) header.push(` * payload type: ${payloadType}`);
  header.push(' */');
  const lines = [...header, `interface ${name} {`, `  ${nameField}`];
  emitTsDict(lines, sketch, '  ');
  lines.push('}', '');
  return lines;
}

// ---------------------------------------------------------------------------
// Static payload fallback — sketch fields from source when the zod schema
// cannot be projected to JSON Schema (payloads using `z.custom<T>()`)
// ---------------------------------------------------------------------------

/** Find the index of the closer matching the opener at `start` (quotes-aware). */
function matchDelimiter(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) return -1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i);
      if (i === -1) return -1;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split `body` into top-level parts on any of `separators` (quotes/nesting-aware). */
function splitTopLevel(body: string, separators: readonly string[] = [',']): string[] {
  const parts: string[] = [];
  let depth = 0;
  let partStart = 0;
  const n = body.length;
  for (let i = 0; i < n; i++) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n && body[i] !== quote) {
        if (body[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth = Math.max(0, depth - 1);
    else if (ch !== undefined && depth === 0 && separators.includes(ch)) {
      parts.push(body.slice(partStart, i).trim());
      partStart = i + 1;
    }
  }
  parts.push(body.slice(partStart).trim());
  return parts.filter((p) => p !== '');
}

/** Split an object literal's body into top-level `key: expr` fields. */
function splitObjectFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of splitTopLevel(body)) {
    const keyMatch = /^([$\w]+|'[^']+'|"[^"]+")\s*:/.exec(part);
    if (keyMatch?.[1] !== undefined) {
      const key = keyMatch[1].replace(/^['"]|['"]$/g, '');
      fields.set(key, part.slice(keyMatch[0].length).trim());
    } else if (part.startsWith('...')) {
      fields.set(part, '');
    }
  }
  return fields;
}

/** Extract the body of the first balanced `{...}` in `text` starting at `braceIndex`. */
function objectBody(text: string, braceIndex: number): string | undefined {
  const end = matchDelimiter(text, braceIndex, '{', '}');
  return end === -1 ? undefined : text.slice(braceIndex + 1, end);
}

/** Read one expression from `start` up to the top-level `;` that ends the statement. */
function readExpression(source: string, start: number): string {
  let depth = 0;
  const n = source.length;
  for (let i = start; i < n; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

/** Quote a string literal TS-style (single quotes) so sketches need no JSON escapes. */
function tsQuote(raw: string): string {
  return raw.includes("'") ? JSON.stringify(raw) : `'${raw}'`;
}

function escapeRegExp(raw: string): string {
  return raw.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve a `schema:` expression to an object-literal body, following local consts. */
function resolveSchemaLiteral(expr: string, source: string, depth = 0): string | undefined {
  if (depth > 2) return undefined;
  // z.object({ ... }) / z.strictObject({ ... }) — inline literal.
  const inline = /^z\.\w*[oO]bject\s*\(/.exec(expr);
  if (inline !== null) {
    const rest = expr.slice(inline[0].length).trimStart();
    if (rest.startsWith('{')) return objectBody(rest, 0);
    // z.object(SHAPE_CONST) — look up the local shape const.
    const shapeName = /^([$\w]+)/.exec(rest)?.[1];
    if (shapeName !== undefined) {
      const constRe = new RegExp(`const\\s+${shapeName}\\s*(?::[^=;]+)?=\\s*\\{`);
      const m = constRe.exec(source);
      if (m !== null) return objectBody(source, m.index + m[0].length - 1);
    }
    return undefined;
  }
  // schema: SOME_CONST — follow `const X = z.object(...)` in the same file.
  const ident = /^([$\w]+)$/.exec(expr.trim())?.[1];
  if (ident !== undefined) {
    const constRe = new RegExp(`const\\s+${ident}\\s*(?::[^=;]+)?=\\s*`);
    const m = constRe.exec(source);
    if (m !== null) {
      const rhs = readExpression(source, m.index + m[0].length).trim();
      return resolveSchemaLiteral(rhs, source, depth + 1);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// TS type summarizer — expand `z.custom<T>()` type names into readable sketches
// by resolving the alias (or interface) across local definitions, imports, and
// re-exports. Discriminated unions collapse to `union on type: "a" | "b"`.
// Resolution work is bounded by a per-expansion step budget.
// ---------------------------------------------------------------------------

interface Budget {
  remaining: number;
}

function spend(budget: Budget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

const TS_BUDGET = (): Budget => ({ remaining: 24 });

const _fileCache = new Map<string, string>();

function readCached(file: string): string {
  let text = _fileCache.get(file);
  if (text === undefined) {
    text = readFileSync(file, 'utf-8');
    _fileCache.set(file, text);
  }
  return text;
}

interface TsField {
  readonly type: string;
  readonly optional: boolean;
}

/** Split a TS object type literal body into fields (separators: `;` / `,`). */
function splitTsTypeFields(body: string): Map<string, TsField> {
  const fields = new Map<string, TsField>();
  for (const part of splitTopLevel(body, [';', ','])) {
    const m = /^(?:readonly\s+)?([$\w]+|'[^']+'|"[^"]+")\s*(\?)?\s*:\s*(.+)$/.exec(part);
    if (m?.[1] !== undefined && m[3] !== undefined) {
      fields.set(m[1].replace(/^['"]|['"]$/g, ''), {
        type: m[3].trim(),
        optional: m[2] !== undefined,
      });
    }
  }
  return fields;
}

const TS_PRIMITIVES = new Set(['string', 'number', 'boolean', 'unknown', 'any', 'null', 'undefined', 'void']);

function renderTsFields(
  fields: Map<string, TsField>,
  file: string,
  budget: Budget,
  charBudget: number,
  depth: number,
): SketchDict {
  const dict: SketchDict = {};
  let count = 0;
  for (const [name, f] of fields) {
    if (count >= 8) {
      dict[MORE_KEY] = '…';
      break;
    }
    count += 1;
    dict[`${name}${f.optional ? '?' : ''}`] = summarizeTsTypeExpr(
      f.type,
      file,
      budget,
      Math.max(120, Math.floor(charBudget / 2)),
      depth + 1,
    );
  }
  return dict;
}

/** Find a local `type X = ...` / `interface X {...}` definition's RHS text. */
function findTsTypeDef(name: string, file: string): string | undefined {
  const source = readCached(file);
  const typeRe = new RegExp(`(?:export\\s+)?type\\s+${name}(?:<[^>;=]*>)?\\s*=\\s*`);
  const m = typeRe.exec(source);
  if (m !== null) return readExpression(source, m.index + m[0].length).trim();
  const ifaceRe = new RegExp(`(?:export\\s+)?interface\\s+${name}(?:<[^>]*>)?(?:\\s+extends[^{]+)?\\s*\\{`);
  const im = ifaceRe.exec(source);
  if (im !== null) {
    const body = objectBody(source, im.index + im[0].length - 1);
    if (body !== undefined) return `{ ${body} }`;
  }
  return undefined;
}

/** Find the module specifier a name is imported (or named-re-exported) from. */
function findImportSource(file: string, name: string): string | undefined {
  const source = readCached(file);
  const re = /(?:import|export)\s+(?:type\s+)?\{([^}]+)\}\s*from\s*'([^']+)'/g;
  for (const m of source.matchAll(re)) {
    for (const part of m[1]!.split(',')) {
      const named = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(part.trim());
      if (named === null) continue;
      if ((named[2] ?? named[1]) === name) return m[2];
    }
  }
  return undefined;
}

function resolveModuleFile(fromFile: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith('#/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = join(dirname(fromFile), specifier);
  else return undefined;
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function summarizeTsUnion(
  members: string[],
  file: string,
  budget: Budget,
  charBudget: number,
  depth: number,
): string {
  // Resolve member idents one level so alias unions (ContextMessage = A | B | C)
  // still expose their object shapes.
  const resolved = members.map((m) => {
    const t = m.trim();
    if (/^[$\w]+$/.test(t)) {
      const def = findTsTypeDef(t, file);
      if (def !== undefined) return def;
    }
    return t;
  });
  const bodies = resolved.map((m) => (m.trim().startsWith('{') ? objectBody(m.trim(), 0) : undefined));
  if (bodies.length > 0 && bodies.every((b) => b !== undefined)) {
    const fieldMaps = bodies.map((b) => splitTsTypeFields(b!));
    // Discriminated union: one field is a string literal in every member.
    for (const [name, info] of fieldMaps[0]!) {
      if (
        /^'[^']*'$/.test(info.type) &&
        fieldMaps.every((fm) => /^'[^']*'$/.test(fm.get(name)?.type ?? ''))
      ) {
        const values = fieldMaps.map((fm) => tsQuote(fm.get(name)!.type.slice(1, -1)));
        return truncate(`union on ${name}: ${values.join(' | ')}`, charBudget);
      }
    }
    // Unions stay one-line strings; object members use the compact renderer.
    return truncate(
      fieldMaps
        .map((fm) => stringifySketch(renderTsFields(fm, file, budget, charBudget, depth + 1)))
        .join(' | '),
      charBudget * 2,
    );
  }
  return truncate(
    members
      .map((m) => stringifySketch(summarizeTsTypeExpr(m, file, budget, charBudget, depth + 1)))
      .join(' | '),
    charBudget * 2,
  );
}

function summarizeTsTypeExpr(
  rhs: string,
  file: string,
  budget: Budget,
  charBudget = 480,
  depth = 0,
): Sketch {
  let text = rhs.replaceAll(/\s+/g, ' ').trim();
  if (text.startsWith('readonly ')) text = text.slice('readonly '.length).trim();
  const literal = /^'([^']*)'$/.exec(text);
  if (literal?.[1] !== undefined) return tsQuote(literal[1]);
  if (TS_PRIMITIVES.has(text)) return text;
  if (text.endsWith('[]')) {
    const inner = summarizeTsTypeExpr(text.slice(0, -2), file, budget, charBudget, depth + 1);
    if (typeof inner !== 'string') return [inner];
    return inner.includes('|') ? `(${inner})[]` : `${inner}[]`;
  }
  const members = splitTopLevel(text, ['|']);
  if (members.length > 1) {
    return spend(budget)
      ? summarizeTsUnion(members, file, budget, charBudget, depth)
      : truncate(text, 80);
  }
  const intersections = splitTopLevel(text, ['&']);
  if (intersections.length > 1) {
    if (!spend(budget)) return truncate(text, 80);
    const sides = intersections.map((m) => summarizeTsTypeExpr(m, file, budget, charBudget, depth + 1));
    // An intersection of object shapes merges into one dictionary.
    if (sides.every((side) => typeof side !== 'string' && !Array.isArray(side))) {
      return Object.assign({}, ...sides) as SketchDict;
    }
    return truncate(sides.map(stringifySketch).join(' & '), charBudget * 2);
  }
  if (text.startsWith('{')) {
    if (!spend(budget) || depth >= 4) return 'object';
    const body = objectBody(text, 0);
    if (body !== undefined) {
      return renderTsFields(splitTsTypeFields(body), file, budget, charBudget, depth);
    }
  }
  if (/^[$\w]+$/.test(text)) {
    const summary = summarizeTsType(text, file, budget);
    if (summary !== undefined) return summary;
  }
  return truncate(text, 80);
}

/** Resolve a type name to a readable summary across aliases, imports, re-exports. */
function summarizeTsType(name: string, fromFile: string, budget: Budget): Sketch | undefined {
  if (!spend(budget)) return undefined;
  const def = findTsTypeDef(name, fromFile);
  if (def !== undefined) return summarizeTsTypeExpr(def, fromFile, budget);
  const specifier = findImportSource(fromFile, name);
  if (specifier !== undefined) {
    const target = resolveModuleFile(fromFile, specifier);
    if (target !== undefined) return summarizeTsType(name, target, budget);
  }
  for (const m of readCached(fromFile).matchAll(/export\s+\*\s+from\s*'([^']+)'/g)) {
    const target = m[1] === undefined ? undefined : resolveModuleFile(fromFile, m[1]);
    if (target === undefined) continue;
    const summary = summarizeTsType(name, target, budget);
    if (summary !== undefined) return summary;
  }
  return undefined;
}

/**
 * Render a zod field expression as a Sketch, in the same notation the
 * JSON-Schema path produces (`string`, `'a' | 'b'`, `Foo[]`). `z.custom<T>()`
 * and bare type idents expand through the TS type summarizer — object shapes
 * become nested dicts (keyed with the type name under `_type`), everything
 * else stays a one-line string.
 */
function friendlyZodExpr(expr: string, ownerFile: string, depth = 0): Sketch {
  let text = expr.replaceAll(/\s+/g, ' ').trim();
  // Strip trailing modifiers the sketch does not mark.
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of ['.optional()', '.nullable()', '.nullish()', '.readonly()']) {
      if (text.endsWith(suffix)) {
        text = text.slice(0, -suffix.length).trim();
        stripped = true;
      }
    }
  }
  const stringLiteral = /^'([^']*)'$/.exec(text);
  if (stringLiteral?.[1] !== undefined) return tsQuote(stringLiteral[1]);
  const custom = /^z\.custom<(.+)>\(\)$/.exec(text);
  if (custom?.[1] !== undefined) {
    const typeName = custom[1].trim();
    // Expand the TS type only at the top levels — nested fields keep the bare
    // type name so long union member sketches stay readable.
    if (depth > 1) return typeName;
    const summary = summarizeTsType(typeName, ownerFile, TS_BUDGET());
    if (summary === undefined) return typeName;
    if (typeof summary !== 'string' && !Array.isArray(summary)) {
      return { [TYPE_KEY]: typeName, ...summary };
    }
    return truncate(`${typeName} = ${stringifySketch(summary)}`, 1024);
  }
  if (/^z\.string\(\)$/.test(text)) return 'string';
  if (/^z\.number\(\)$/.test(text)) return 'number';
  if (/^z\.boolean\(\)$/.test(text)) return 'boolean';
  if (/^z\.(?:int|integer)\(\)$/.test(text)) return 'integer';
  const array = /^z\.array\((.+)\)$/.exec(text);
  if (array?.[1] !== undefined) {
    const inner = friendlyZodExpr(array[1], ownerFile, depth + 1);
    if (typeof inner !== 'string') return [inner];
    return `${inner}[]`;
  }
  const literal = /^z\.literal\((.+)\)$/.exec(text);
  if (literal?.[1] !== undefined) return friendlyZodExpr(literal[1], ownerFile, depth + 1);
  const union = /^z\.union\((.+)\)$/.exec(text);
  if (union?.[1] !== undefined) return friendlyZodUnion(union[1], ownerFile, depth);
  const enumMatch = /^z\.enum\((.+)\)$/.exec(text);
  if (enumMatch?.[1] !== undefined) {
    const body = enumMatch[1].trim().replace(/^\[/, '').replace(/\]$/, '');
    return splitTopLevel(body)
      .map((member) => stringifySketch(friendlyZodExpr(member, ownerFile, depth + 1)))
      .join(' | ');
  }
  const record = /^z\.record\((.+)\)$/.exec(text);
  if (record?.[1] !== undefined) {
    const parts = splitTopLevel(record[1]);
    if (parts.length === 2) {
      return `record<string, ${stringifySketch(friendlyZodExpr(parts[1]!, ownerFile, depth + 1))}>`;
    }
  }
  if (/^z\.\w*[oO]bject\(/.test(text)) {
    if (depth >= 3) return 'object';
    const body = resolveSchemaLiteral(text, readCached(ownerFile));
    if (body === undefined) return 'object';
    const dict: SketchDict = {};
    for (const [key, fieldExpr] of splitObjectFields(body)) {
      if (fieldExpr === '') {
        dict[key] = '(spread)';
        continue;
      }
      const optional = /\.(?:optional|nullish)\(\)$/.test(fieldExpr);
      dict[`${key}${optional ? '?' : ''}`] = friendlyZodExpr(fieldExpr, ownerFile, depth + 1);
    }
    return dict;
  }
  const ident = /^([$\w]+)$/.exec(text)?.[1];
  if (ident !== undefined && depth < 4) {
    const source = readCached(ownerFile);
    const constRe = new RegExp(`const\\s+${ident}\\s*(?::[^=;]+)?=\\s*`);
    const m = constRe.exec(source);
    if (m !== null) {
      const rhs = readExpression(source, m.index + m[0].length).trim();
      return friendlyZodExpr(rhs, ownerFile, depth + 1);
    }
    if (depth <= 1) {
      const summary = summarizeTsType(ident, ownerFile, TS_BUDGET());
      if (summary !== undefined) {
        if (typeof summary !== 'string' && !Array.isArray(summary)) {
          return { [TYPE_KEY]: ident, ...summary };
        }
        return truncate(`${ident} = ${stringifySketch(summary)}`, 320);
      }
    }
  }
  return truncate(text, 80);
}

/** Sketch a `z.union([...])` body (one-line string); object members get field sketches. */
function friendlyZodUnion(body: string, ownerFile: string, depth: number): string {
  const members = splitTopLevel(body.trim().replace(/^\[/, '').replace(/\]$/, ''));
  const source = readCached(ownerFile);
  const bodies = members.map((m) => resolveSchemaLiteral(m, source));
  if (members.length > 0 && bodies.every((b) => b !== undefined)) {
    const fieldMaps = bodies.map((b) => splitObjectFields(b));
    // Hoist spreads shared by every member (`...base & { … } | { … }`).
    const spreadSets = fieldMaps.map((fm) => [...fm.keys()].filter((k) => fm.get(k) === ''));
    const commonSpreads = (spreadSets[0] ?? []).filter((s) =>
      spreadSets.every((set) => set.includes(s)),
    );
    const sketches = fieldMaps.map((fm) => {
      const dict: SketchDict = {};
      for (const [key, expr] of fm) {
        if (expr === '') continue;
        const optional = /\.(?:optional|nullish)\(\)$/.test(expr);
        dict[`${key}${optional ? '?' : ''}`] = friendlyZodExpr(expr, ownerFile, depth + 1);
      }
      return stringifySketch(dict);
    });
    const prefix = commonSpreads.length > 0 ? `${commonSpreads.join(' + ')} & ` : '';
    return truncate(`${prefix}${sketches.join(' | ')}`, 320);
  }
  return truncate(
    members.map((m) => stringifySketch(friendlyZodExpr(m, ownerFile, depth + 1))).join(' | '),
    320,
  );
}

/**
 * Best-effort payload sketch from the owner source for schemas that use
 * `z.custom` (not representable as JSON Schema). Returns a field map for
 * object payloads, a type string for whole-payload custom schemas, or
 * `undefined` when the source shape is not recognized.
 */
function sketchPayloadFromSource(
  ownerFile: string,
  type: string,
): string | Map<string, Sketch> | undefined {
  const absFile = join(PKG, ownerFile);
  const source = readCached(absFile);
  const typeRe = new RegExp(
    `static\\s+override\\s+readonly\\s+type\\s*=\\s*'${escapeRegExp(type)}'`,
  );
  const typeMatch = typeRe.exec(source);
  if (typeMatch === null) return undefined;
  const rest = source.slice(typeMatch.index + typeMatch[0].length);
  const nextType = /static\s+override\s+readonly\s+type\s*=/.exec(rest);
  const classWindow = nextType === null ? rest : rest.slice(0, nextType.index);
  const schemaMatch = /static\s+override\s+readonly\s+schema\s*=\s*/.exec(classWindow);
  if (schemaMatch === null) return undefined;
  const schemaExpr = readExpression(
    classWindow,
    schemaMatch.index + schemaMatch[0].length,
  ).trim();
  if (schemaExpr === '') return undefined;
  const literal = resolveSchemaLiteral(schemaExpr, source);
  if (literal === undefined) {
    const sketch = friendlyZodExpr(schemaExpr, absFile);
    if (typeof sketch === 'string') return sketch;
    if (!Array.isArray(sketch)) return new Map(Object.entries(sketch));
    return stringifySketch(sketch);
  }
  const sketch = new Map<string, Sketch>();
  for (const [key, expr] of splitObjectFields(literal)) {
    if (expr === '') {
      sketch.set(key, '(spread)');
      continue;
    }
    const optional = /\.(?:optional|nullish)\(\)$/.test(expr);
    sketch.set(`${key}${optional ? '?' : ''}`, friendlyZodExpr(expr, absFile));
  }
  return sketch;
}

// ---------------------------------------------------------------------------
// Manifest rendering
// ---------------------------------------------------------------------------

export async function buildWireManifest(): Promise<string> {
  const { owners, importFiles, durableTypes, classTypes } = scanEventDeclarations();
  // "import = register": loading the package root plus every event/state module
  // found in the static pass fills EVENT2_REGISTRY, even for
  // modules index.ts does not load.
  await import('../src/index.ts');
  for (const file of importFiles) {
    await import(relative(join(PKG, 'scripts'), file));
  }
  const { WIRE_PROTOCOL_VERSION } = (await import('#/wire/migration/migration')) as {
    WIRE_PROTOCOL_VERSION: string;
  };

  const entries = [...EVENT2_REGISTRY.values()].toSorted((a, b) => a.type.localeCompare(b.type));
  const migrationChain = scanMigrationChain();

  // type → folding states / blob codec owners, scanned from the defineState chains.
  const folding = new Map<string, { states: string[]; blobs: string[] }>();
  const protocolTypes = scanUndoableProtocolTypes(classTypes);
  for (const state of scanReplayableStates()) {
    const eventTypes = new Set<string>();
    for (const cls of state.foldClasses) {
      const type = classTypes.get(cls);
      if (type === undefined) {
        throw new Error(
          `[gen-wire-manifest] state '${state.keyName}' folds unresolved event class '${cls}'`,
        );
      }
      eventTypes.add(type);
    }
    if (state.undoable) {
      for (const type of protocolTypes) eventTypes.add(type);
    }
    for (const type of eventTypes) {
      let info = folding.get(type);
      if (info === undefined) {
        info = { states: [], blobs: [] };
        folding.set(type, info);
      }
      info.states.push(state.keyName);
      if (state.blobs) info.blobs.push(state.keyName);
    }
  }
  for (const info of folding.values()) {
    info.states.sort();
    info.blobs.sort();
  }

  const unregistered = [...durableTypes].filter((type) => !EVENT2_REGISTRY.has(type));
  if (unregistered.length > 0) {
    console.error(
      `[gen-wire-manifest] declared durable but never registered (no fold, not in EVENT2_REGISTRY): ${unregistered.toSorted().join(', ')}`,
    );
  }

  const out: string[] = [
    '// Wire Protocol Manifest',
    '//',
    '// Generated by scripts/gen-wire-manifest.mts — do not edit by hand.',
    '// Regenerate with: pnpm --filter @moonshot-ai/agent-core-v2 gen:wire-manifest',
    '//',
    `// protocol_version: "${WIRE_PROTOCOL_VERSION}" (migrations: ${migrationChain})`,
    '//',
    '// One declaration per durable record type — an Event2 subclass declaring',
    '// `static type` + `static durable = true` + `static schema` — drained from the',
    '// runtime EVENT2_REGISTRY ("import = register"). Every payload declaration',
    '// carries its record type in a `_name` field. Payload sketches use TypeScript',
    '// type syntax; when a named type is expanded inline, its name appears as a doc',
    '// comment (`/** ContextMessage */`). Bare type names (ContentPart,',
    '// ContextMessage, …) refer to the real types in src/ — they are intentionally',
    '// not resolved here. `// …` marks a capped field list. On disk (wire.jsonl)',
    '// the journal opens with a metadata line {"type": "metadata",',
    '// "protocol_version", "created_at"}; each record is {"type", ...payload,',
    '// "time"} — object payloads spread at the top level.',
    '//',
    '// Every listed type is durable by construction — transient Event2 classes',
    '// never enter EVENT2_REGISTRY, so there is no persisted flag. Declaration',
    '// header lines: states (every state folding this record type on dispatch and',
    '// replay; any state beyond the first is what the retired format listed as',
    '// cross-reducers), blobs (the folding states whose blob codec offloads inline',
    '// media to blob storage), owner (the source file declaring the class).',
    '',
    `// Index (${entries.length} record types)`,
  ];
  const width = Math.max(...entries.map((e) => e.type.length));
  const statesWidth = Math.max(
    ...entries.map((e) => (folding.get(e.type)?.states.join(', ') ?? '(none)').length),
  );
  for (const entry of entries) {
    const states = folding.get(entry.type)?.states.join(', ') ?? '(none)';
    out.push(
      `//   ${entry.type.padEnd(width)}  ${states.padEnd(statesWidth)}  ${owners.get(entry.type) ?? '(unresolved)'}`,
    );
  }
  out.push('');
  const declNames: [string, string][] = [];
  for (const entry of entries) {
    const info = folding.get(entry.type);
    const states = info?.states ?? [];
    const flags: string[] = [];
    if (info !== undefined && info.blobs.length > 0) flags.push(`blobs: ${info.blobs.join(', ')}`);
    const owner = owners.get(entry.type);
    const staticSketch =
      owner === undefined ? undefined : sketchPayloadFromSource(owner, entry.type);
    const sketch = buildPayloadSketch(entry.schema as unknown, staticSketch);
    out.push(...renderPayloadDecl(entry, owner, states, flags, sketch));
    declNames.push([entry.type, `${pascalCase(entry.type)}Payload`]);
  }

  // Record type → payload declaration map.
  out.push('/** Record type → payload sketch. */');
  out.push('interface WirePayloadMap {');
  for (const [type, declName] of declNames) {
    out.push(`  ${JSON.stringify(type)}: ${declName};`);
  }
  out.push('}');
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const manifest = await buildWireManifest();
  if (check) {
    let current: string | undefined;
    try {
      current = readFileSync(MANIFEST_PATH, 'utf-8');
    } catch {
      current = undefined;
    }
    if (current !== manifest) {
      console.error(
        `[gen-wire-manifest] ${relative(process.cwd(), MANIFEST_PATH)} is stale. ` +
          'Regenerate with `pnpm --filter @moonshot-ai/agent-core-v2 gen:wire-manifest`.',
      );
      process.exit(1);
    }
    console.log('[gen-wire-manifest] up to date');
    return;
  }
  writeFileSync(MANIFEST_PATH, manifest);
  console.log(`[gen-wire-manifest] wrote ${relative(process.cwd(), MANIFEST_PATH)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

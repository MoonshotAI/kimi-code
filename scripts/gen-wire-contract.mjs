#!/usr/bin/env node
/**
 * Generate TypeScript wire types from the Rust RPC contract.
 *
 * Source of truth: `packages/kimi-agent/src/rpc/types.rs` (plus any crate
 * types it references, e.g. `GoalContext`). The JSON-RPC wire serializes
 * struct fields verbatim (snake_case, no renames), so the generated
 * interfaces mirror Rust field names exactly.
 *
 * Usage: `pnpm gen:wire`  →  writes `packages/kimi-agent/src/rpc/wire.gen.ts`
 *
 * The generated file is committed. Run it whenever RPC types change, and
 * verify nothing drifted with `git diff --exit-code` on wire.gen.ts.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'packages', 'kimi-agent', 'src');
const PRIMARY = join(SRC, 'rpc', 'types.rs');
const OUT = join(SRC, 'rpc', 'wire.gen.ts');

// ── Collect all .rs sources ────────────────────────────────────────────
function collectRs(dir) {
  const out = new Map();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      for (const [k, v] of collectRs(full)) out.set(k, v);
    } else if (entry.endsWith('.rs')) {
      out.set(relative(SRC, full).replaceAll('\\', '/'), readFileSync(full, 'utf8'));
    }
  }
  return out;
}

const SOURCES = collectRs(SRC);

// ── Parsing helpers ────────────────────────────────────────────────────
const STRUCT_RE = /pub struct (\w+)\s*\{([\s\S]*?)\n\}/g;
const ENUM_RE = /pub enum (\w+)\s*\{(.*?)\n\}/gs;
const ALIAS_RE = /pub type (\w+)\s*=\s*([^;]+);/g;

function attrsAbove(lines, index) {
  // Collect #[...] attribute lines directly above `index`.
  const attrs = [];
  for (let i = index - 1; i >= 0 && lines[i].trim().startsWith('#'); i--) {
    attrs.unshift(lines[i].trim());
  }
  return attrs;
}

function docAbove(lines, index) {
  const docs = [];
  for (let i = index - 1; i >= 0 && lines[i].trim().startsWith('///'); i--) {
    docs.unshift(lines[i].trim().replace(/^\/\/\/\s?/, ''));
  }
  return docs;
}

function parseStructs(text) {
  const structs = new Map();
  for (const m of text.matchAll(STRUCT_RE)) {
    const name = m[1];
    const lines = m[2].split('\n');
    const fields = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('pub ') || !line.endsWith(',')) continue;
      const body = line.slice(4, -1).trim();
      const sep = body.indexOf(':');
      if (sep < 0) continue;
      let fieldName = body.slice(0, sep).trim();
      const rawType = body.slice(sep + 1).trim();
      const attrs = attrsAbove(lines, i).join(' ');
      const optional =
        /#\[serde\((?:[^)]*\bdefault\b[^)]*|.*skip_serializing_if.*)\)\]/.test(
          `#[serde(${attrs.match(/serde\(([^)]*)\)/)?.[1] ?? ''})]`,
        );
      if (fieldName === 'r#type') fieldName = 'type';
      fields.push({ name: fieldName, rawType, optional, docs: docAbove(lines, i) });
    }
    structs.set(name, { kind: 'struct', name, fields });
  }
  return structs;
}

function parseEnums(text) {
  const enums = new Map();
  for (const m of text.matchAll(ENUM_RE)) {
    const name = m[1];
    const lines = m[2].split('\n');
    const variants = [];
    let pending = null; // multi-line struct variant: { name, fields, renameLine }
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      const renameLine = i > 0 && lines[i - 1].trim().startsWith('#[serde(rename')
        ? lines[i - 1].trim().match(/rename = "([^"]+)"/)?.[1]
        : undefined;
      if (raw.startsWith('#')) continue;
      // Multi-line struct variant: `Name {` ... `}`.
      if (pending === null && /^(\w+)\s*\{\s*$/.test(raw)) {
        const headerMatch = raw.match(/^(\w+)\s*\{/);
        pending = {
          name: headerMatch[1],
          fields: [],
          renameLine,
        };
        continue;
      }
      if (pending !== null) {
        if (/^\},?$/.test(raw)) {
          variants.push({
            name: pending.renameLine ?? pending.name,
            kind: 'struct',
            fields: pending.fields,
          });
          pending = null;
          continue;
        }
        const field = raw.replace(/,$/, '').trim();
        if (!field) continue;
        const [fn, ...rest] = field.split(':').map((s) => s.trim());
        pending.fields.push({ name: fn, rawType: rest.join(':') });
        continue;
      }
      const t = raw.replace(/,$/, '').trim();
      if (t.startsWith('#')) continue;
      // struct variant: Name { a: T, b: T }
      const structM = t.match(/^(\w+)\s*\{\s*(.*?)\s*\}$/);
      const unitM = t.match(/^(\w+)$/);
      if (structM) {
        const fields = [];
        for (const f of structM[2].split(',').filter(Boolean)) {
          const [fn, ...rest] = f.split(':').map((s) => s.trim());
          fields.push({ name: fn, rawType: rest.join(':') });
        }
        variants.push({ name: renameLine ?? structM[1], kind: 'struct', fields });
      } else if (unitM) {
        variants.push({ name: renameLine ?? unitM[1], kind: 'unit' });
      }
    }
    enums.set(name, { kind: 'enum', name, variants });
  }
  return enums;
}

function parseAliases(text) {
  const aliases = new Map();
  for (const m of text.matchAll(ALIAS_RE)) {
    aliases.set(m[1], m[2].trim());
  }
  return aliases;
}

// ── Type mapping ───────────────────────────────────────────────────────
const PRIMITIVES = {
  String: 'string',
  u8: 'number',
  u16: 'number',
  u32: 'number',
  u64: 'number',
  usize: 'number',
  i8: 'number',
  i16: 'number',
  i32: 'number',
  i64: 'number',
  isize: 'number',
  f32: 'number',
  f64: 'number',
  bool: 'boolean',
};

const registry = { structs: new Map(), enums: new Map(), aliases: new Map(), files: new Map() };
const warnings = [];

function registerFile(key, text) {
  const s = parseStructs(text);
  const e = parseEnums(text);
  const a = parseAliases(text);
  for (const [k, v] of s) {
    registry.structs.set(k, v);
    registry.files.set(k, key);
  }
  for (const [k, v] of e) {
    registry.enums.set(k, v);
    registry.files.set(k, key);
  }
  for (const [k, v] of a) registry.aliases.set(k, v);
}

for (const [key, text] of SOURCES) registerFile(key, text);

function mapType(rawType) {
  let t = rawType.trim();
  let m = t.match(/^Option<(.+)>$/);
  if (m) return mapType(m[1]);
  m = t.match(/^Vec<(.+)>$/);
  if (m) return `Array<${mapType(m[1])}>`;
  m = t.match(/^Box<(.+)>$/);
  if (m) return mapType(m[1]);
  m = t.match(/^(?:std::collections::)?HashMap<(.+),\s*(.+)>$/);
  if (m) return `Record<string, ${mapType(m[2])}>`;
  if (t === 'serde_json::Value' || t === 'RequestId') return 'unknown';
  if (PRIMITIVES[t]) return PRIMITIVES[t];
  const tail = baseName(t);
  if (tail && (registry.structs.has(tail) || registry.enums.has(tail) || registry.aliases.has(tail))) {
    return tail;
  }
  if (tail && !warnings.includes(tail)) warnings.push(tail);
  return 'unknown';
}

/** Strip containers and path prefixes down to the bare type name. */
function baseName(rawType) {
  let t = rawType.trim();
  let m = t.match(/^(Option|Vec|Box)<(.+)>$/);
  while (m) {
    t = m[2];
    m = t.match(/^(Option|Vec|Box)<(.+)>$/);
  }
  return (t.split('::').pop() ?? '').replace(/<.*$/, '');
}

// ── Rendering ──────────────────────────────────────────────────────────
function renderField(field) {
  const type = mapType(field.rawType);
  const isOption = /^Option<.+>$/.test(field.rawType.trim());
  const optional = field.optional || isOption;
  // `unknown` already covers `undefined`; appending it only trips
  // no-redundant-type-constituents in type-aware linting.
  const tsType = isOption && type !== 'unknown' ? `${type} | undefined` : type;
  const docs = field.docs.length > 0 ? `  /** ${field.docs.join(' ')} */\n` : '';
  return `${docs}  ${field.name}${optional ? '?' : ''}: ${tsType};`;
}

function renderStruct(struct) {
  const body = struct.fields.map(renderField).join('\n');
  return `export interface ${struct.name} {\n${body}\n}`;
}

function renderEnum(enumDef, attrs) {
  const wireName = (rustName) => {
    if (attrs.renameAll === 'snake_case') {
      return rustName.replaceAll(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
    }
    if (attrs.renameAll === 'camelCase') {
      return rustName[0].toLowerCase() + rustName.slice(1);
    }
    return rustName;
  };
  // Tagged enum with struct variants → discriminated union. Unit variants
  // serialize as `{"kind":"user"}`-style objects under the tag, so they are
  // members too.
  if (enumDef.variants.some((v) => v.kind === 'struct')) {
    const tag = attrs.tag ?? 'type';
    const members = enumDef.variants.map((v) => {
      const tagName = `'${wireName(v.name)}'`;
      if (v.kind === 'struct') {
        const fields = v.fields.map((f) => `${f.name}: ${mapType(f.rawType)}`).join('; ');
        return `  | { ${tag}: ${tagName}; ${fields} }`;
      }
      return `  | { ${tag}: ${tagName} }`;
    });
    return `export type ${enumDef.name} =\n${members.join('\n')};`;
  }
  // Plain unit enum → union of string literals (serde rename honored).
  const literals = enumDef.variants.map((v) => `'${wireName(v.name)}'`).join(' | ');
  return `export type ${enumDef.name} = ${literals};`;
}

function renderAlias(name, raw) {
  let type = mapType(raw);
  if (/^Option<.+>$/.test(raw.trim())) {
    // A top-level Option alias serializes as JSON null (not field-absence),
    // so mirror that with `| null` rather than `| undefined`.
    type = `${mapType(raw.slice(7, -1))} | null`;
  }
  return `export type ${name} = ${type};`;
}

// ── Resolve entry set: everything declared in the primary wire file ────
const primary = readFileSync(PRIMARY, 'utf8');
const seed = new Set();
for (const m of primary.matchAll(STRUCT_RE)) seed.add(m[1]);
for (const m of primary.matchAll(ENUM_RE)) seed.add(m[1]);
for (const m of primary.matchAll(ALIAS_RE)) seed.add(m[1]);

const rendered = new Map();
const inProgress = new Set();

function emit(name) {
  if (rendered.has(name) || inProgress.has(name)) return;
  inProgress.add(name);
  if (registry.structs.has(name)) {
    const s = registry.structs.get(name);
    for (const f of s.fields) {
      const dep = baseName(f.rawType);
      if (dep && (registry.structs.has(dep) || registry.enums.has(dep))) emit(dep);
    }
    rendered.set(name, renderStruct(s));
  } else if (registry.enums.has(name)) {
    const e = registry.enums.get(name);
    // Enum struct-variant fields may reference crate types (e.g. `ContentPart`
    // → `ImageUrlValue`) — emit them before rendering the enum.
    for (const v of e.variants) {
      if (v.kind === 'struct') {
        for (const f of v.fields) {
          const dep = baseName(f.rawType);
          if (dep && (registry.structs.has(dep) || registry.enums.has(dep))) emit(dep);
        }
      }
    }
    // Serde attrs come from the enum's own source file — `rename_all` /
    // `tag` live next to the definition, which may not be types.rs
    // (e.g. `MessageOrigin` uses `tag = "kind"` in context/types.rs).
    const fileKey = registry.files.get(name);
    const text = fileKey === 'rpc/types.rs' ? primary : (SOURCES.get(fileKey) ?? primary);
    const idx = text.indexOf(`pub enum ${name}`);
    const attrs = idx >= 0 ? (text.slice(0, idx).match(/#\[serde\(([^)]*)\)\]\s*$/)?.[1] ?? '') : '';
    const tag = attrs.match(/tag = "(\w+)"/)?.[1];
    const renameAll = attrs.match(/rename_all = "(\w+)"/)?.[1];
    rendered.set(name, renderEnum(e, { tag, renameAll }));
  } else if (registry.aliases.has(name)) {
    const raw = registry.aliases.get(name);
    // Emit the alias target too, so `pub type X = crate::usage::UsageStatus;`
    // (a struct living outside types.rs) renders a concrete interface instead
    // of a dangling reference.
    const dep = baseName(raw);
    if (dep && (registry.structs.has(dep) || registry.enums.has(dep) || registry.aliases.has(dep))) {
      emit(dep);
    }
    rendered.set(name, renderAlias(name, raw));
  }
  inProgress.delete(name);
}

for (const name of seed) emit(name);

// ── Emit ───────────────────────────────────────────────────────────────
const header = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * TypeScript mirror of the Rust JSON-RPC wire contract
 * (\`packages/kimi-agent/src/rpc/types.rs\` + referenced crate types).
 * Field names/optionality follow serde exactly (snake_case, \`#[serde(default)]\`
 * → optional, \`Option<T>\` → \`T | undefined\`).
 *
 * Regenerate with: \`pnpm gen:wire\`
 */

`;

const body = [...rendered.keys()]
  .map((name) => rendered.get(name))
  .join('\n\n');

writeFileSync(OUT, header + body + '\n');

if (warnings.length > 0) {
  console.warn(`[gen-wire-contract] unresolved types (emitted as unknown): ${warnings.join(', ')}`);
}
console.log(`[gen-wire-contract] wrote ${relative(ROOT, OUT)} (${rendered.size} types)`);

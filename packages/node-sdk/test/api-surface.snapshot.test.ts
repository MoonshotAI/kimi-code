/**
 * Public API surface snapshot for `@moonshot-ai/kimi-code-sdk`.
 *
 * The package's only public entry is `src/index.ts` (see the `exports` map in
 * `package.json`). This test statically enumerates every name exported from that
 * entry — value exports, `export type`/`export interface` declarations, inline
 * `type` specifiers, and `export *` / `export type *` re-exports (resolved one
 * level into the internal `#/...` modules) — then sorts them and compares
 * against the committed snapshot.
 *
 * Static parsing is used instead of `Object.keys(await import(...))` so that
 * type-only exports (which are erased at runtime) are captured too; the result
 * is the complete public surface, not just the runtime value exports. Any export
 * add/remove/rename fails this test until the snapshot is updated.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const SRC_ROOT = join(PACKAGE_ROOT, 'src');

function readSource(absPath: string): string {
  return readFileSync(absPath, 'utf8');
}

/** Strip line + block comments so `export` inside comments is ignored. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Parse one `foo`, `type foo`, or `foo as bar` specifier into its exported name. */
function exportedName(specifier: string): string | null {
  let s = specifier.trim();
  if (s.length === 0) {
    return null;
  }
  // Strip a leading `type` modifier (inline type-only re-export).
  s = s.replace(/^type\s+/, '');
  // `local as exported` -> the public name is `exported`.
  const asMatch = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(s);
  if (asMatch) {
    return asMatch[1] ?? null;
  }
  const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(s);
  return nameMatch ? (nameMatch[1] ?? null) : null;
}

/**
 * Resolve an internal module specifier to an absolute `.ts` file.
 * Handles `#/...` via the package `imports` map pattern
 * (`./src/<x>.ts` then `./src/<x>/index.ts`) and relative specifiers.
 * Returns null for external (bare) specifiers, which we do not expand.
 */
function resolveModule(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('#/')) {
    const sub = specifier.slice(2);
    const candidates = [join(SRC_ROOT, `${sub}.ts`), join(SRC_ROOT, sub, 'index.ts')];
    for (const candidate of candidates) {
      try {
        readSource(candidate);
        return candidate;
      } catch {
        // try next candidate
      }
    }
    return null;
  }
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(fromFile), specifier);
    const candidates = [base, `${base}.ts`, join(base, 'index.ts')];
    for (const candidate of candidates) {
      try {
        readSource(candidate);
        return candidate;
      } catch {
        // try next candidate
      }
    }
    return null;
  }
  return null;
}

/**
 * Collect the names exported by a single file, recursively expanding any
 * `export *` / `export type *` re-exports from internal modules.
 */
function collectExports(absPath: string, seen: Set<string>, out: Set<string>): void {
  if (seen.has(absPath)) {
    return;
  }
  seen.add(absPath);

  const src = stripComments(readSource(absPath));

  // 1. Named (re-)exports: `export { a, type b, c as d } [from 'x']`
  //    and `export type { a, b } from 'x'`. Specifier blocks may span lines.
  const namedRe = /export\s+(?:type\s+)?\{([\s\S]*?)\}/g;
  let match: RegExpExecArray | null;
  while ((match = namedRe.exec(src)) !== null) {
    const block = match[1];
    if (block === undefined) {
      continue;
    }
    for (const raw of block.split(',')) {
      const name = exportedName(raw);
      if (name !== null) {
        out.add(name);
      }
    }
  }

  // 2. Named declarations: `export type|interface|class|function|const|let|var|enum Foo`
  const declRe =
    /export\s+(?:declare\s+)?(?:type|interface|class|function|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g;
  while ((match = declRe.exec(src)) !== null) {
    const name = match[1];
    if (name !== undefined) {
      out.add(name);
    }
  }

  // 3. Star re-exports: `export [type] * from 'x'` (internal modules only).
  const starRe = /export\s+(?:type\s+)?\*\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = starRe.exec(src)) !== null) {
    const specifier = match[1];
    if (specifier === undefined) {
      continue;
    }
    const target = resolveModule(specifier, absPath);
    if (target !== null) {
      collectExports(target, seen, out);
    }
  }
}

function collectPublicExports(): string[] {
  const entry = join(SRC_ROOT, 'index.ts');
  const out = new Set<string>();
  collectExports(entry, new Set<string>(), out);
  return [...out].sort();
}

describe('node-sdk API surface snapshot', () => {
  it('matches the public export snapshot', () => {
    const exports = collectPublicExports();
    expect(exports).toMatchSnapshot();
  });
});

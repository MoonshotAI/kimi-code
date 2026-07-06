import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DuplicateOpError, defineModel, defineOp } from '#/wire';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(PKG_ROOT, 'src');
const FIXTURE_ROOT = join(__dirname, 'fixtures');

const DEFINE_OP_RE = /defineOp\s*\(\s*\w+\s*,\s*['"]([^'"]+)['"]/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walk(abs));
    } else if (abs.endsWith('.ts') && !abs.endsWith('.test.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function scanDefineOpTypes(dir: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const file of walk(dir)) {
    const source = readFileSync(file, 'utf8');
    DEFINE_OP_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DEFINE_OP_RE.exec(source)) !== null) {
      const type = match[1]!;
      const files = seen.get(type) ?? [];
      files.push(file);
      seen.set(type, files);
    }
  }
  return seen;
}

function duplicates(seen: Map<string, string[]>): Map<string, string[]> {
  const dupes = new Map<string, string[]>();
  for (const [type, files] of seen) {
    if (files.length > 1) dupes.set(type, files);
  }
  return dupes;
}

describe('op-uniqueness', () => {
  it('defineOp throws DuplicateOpError when a type is registered twice', () => {
    const model = defineModel('lint.model', () => ({}));
    const type = `lint.dup.${Date.now()}`;
    defineOp(model, type, { apply: (s) => s });
    expect(() => defineOp(model, type, { apply: (s) => s })).toThrow(DuplicateOpError);
  });

  it('finds no duplicate defineOp types across src/', () => {
    const seen = scanDefineOpTypes(SRC_ROOT);
    expect(duplicates(seen)).toEqual(new Map());
  });

  it('flags the planted duplicate in the fixture', () => {
    const seen = scanDefineOpTypes(FIXTURE_ROOT);
    const dupes = duplicates(seen);
    expect(dupes.has('fixture.planted')).toBe(true);
    expect(dupes.get('fixture.planted')).toHaveLength(2);
  });
});

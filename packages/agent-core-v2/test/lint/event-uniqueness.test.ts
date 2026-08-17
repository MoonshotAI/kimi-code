/**
 * Event type uniqueness lint — statically scans `src/**` for duplicate durable
 * event type declarations (`static override readonly type` inside a class
 * carrying `static override readonly durable = true`), and runtime-checks the
 * two registration channels: `registerEvent2Class` fails fast with
 * `DuplicateEventError` on a colliding durable class, while
 * `foldEventStateContributions` (the contribution seam) skips a colliding
 * record and reports it through `onUnexpectedError`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import {
  DuplicateEventError,
  EVENT2_REGISTRY,
  Event2,
  registerEvent2Class,
} from '#/app/event/event2';
import { foldEventStateContributions } from '#/state/stateContribution';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(PKG_ROOT, 'src');
const FIXTURE_ROOT = join(__dirname, 'fixtures');

const TYPE_DECL_RE = /static\s+override\s+readonly\s+type\s*=\s*['"]([^'"]+)['"]/g;
const DURABLE_DECL_RE = /static\s+override\s+readonly\s+durable\s*=\s*true/;

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

function scanDurableEventTypes(dir: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const file of walk(dir)) {
    const source = readFileSync(file, 'utf8');
    const matches = [...source.matchAll(TYPE_DECL_RE)];
    for (const [i, match] of matches.entries()) {
      const windowEnd = i + 1 < matches.length ? matches[i + 1]!.index : source.length;
      if (!DURABLE_DECL_RE.test(source.slice(match.index, windowEnd))) continue;
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

class LintDuplicateA extends Event2<Record<string, never>> {
  static override readonly type = 'lint.duplicate.runtime';
  static override readonly durable = true;
  static override readonly schema = z.object({});
}

class LintDuplicateB extends Event2<Record<string, never>> {
  static override readonly type = 'lint.duplicate.runtime';
  static override readonly durable = true;
  static override readonly schema = z.object({});
}

class LintFoldA extends Event2<Record<string, never>> {
  static override readonly type = 'lint.duplicate.contributed';
  static override readonly durable = true;
  static override readonly schema = z.object({});
}

class LintFoldB extends Event2<Record<string, never>> {
  static override readonly type = 'lint.duplicate.contributed';
  static override readonly durable = true;
  static override readonly schema = z.object({});
}

describe('event-uniqueness', () => {
  it('registerEvent2Class throws DuplicateEventError when a different class reuses a type', () => {
    try {
      registerEvent2Class(LintDuplicateA);
      expect(() => registerEvent2Class(LintDuplicateA)).not.toThrow();
      expect(() => registerEvent2Class(LintDuplicateB)).toThrow(DuplicateEventError);
    } finally {
      EVENT2_REGISTRY.delete('lint.duplicate.runtime');
    }
  });

  it('foldEventStateContributions keeps the first record of a duplicated type and reports the rest', () => {
    const errors: unknown[] = [];
    setUnexpectedErrorHandler((error) => errors.push(error));
    try {
      const folded = foldEventStateContributions(
        [{ events: [LintFoldA] }, { events: [LintFoldB] }],
        [],
      );
      expect(folded.events.get('lint.duplicate.contributed')).toBe(LintFoldA);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain('lint.duplicate.contributed');
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('finds no duplicate durable event type declarations across src/', () => {
    const seen = scanDurableEventTypes(SRC_ROOT);
    expect(duplicates(seen)).toEqual(new Map());
  });

  it('flags the planted duplicate in the fixture', () => {
    const seen = scanDurableEventTypes(FIXTURE_ROOT);
    const dupes = duplicates(seen);
    expect(dupes.has('fixture.planted')).toBe(true);
    expect(dupes.get('fixture.planted')).toHaveLength(2);
  });
});

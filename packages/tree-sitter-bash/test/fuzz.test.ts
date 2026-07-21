// test/fuzz.test.ts
//
// Deterministic fuzzing (fixed-seed PRNG — no per-run randomness; scale the
// volume with TS_BASH_FUZZ_SCALE=N for deeper local runs):
//   a) token soup — random sequences of bash operators/keywords/fragments;
//   b) byte mutations of the curated fixtures (replace/delete/insert,
//      NUL included);
//   c) nesting bombs — programmatic deep $(…) / (…) / ${…} / if nesting.
//
// Contract under test: parse never throws; within budget it returns either
// ok:true or { ok:false, reason:'aborted' }; an ok:true tree is always
// structurally sound (assertTreeIntegrity); nesting beyond the documented
// depth caps degrades locally (hasError) instead of throwing.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parse } from '#/parse';
import type { ParseOptions, ParseResult } from '#/parse';
import { assertTreeIntegrity, parseFixtureFile } from './helpers/differential';

const PKG_ROOT = path.resolve(import.meta.dirname, '..');
const SCALE = Math.max(1, Number(process.env['TS_BASH_FUZZ_SCALE'] ?? 1) || 1);

/** Park–Miller minimal standard PRNG: small, portable, deterministic. */
function prng(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function pick(rand: () => number, pool: readonly string[]): string {
  return pool[Math.floor(rand() * pool.length)]!;
}

function checkContract(source: string, options?: ParseOptions): ParseResult {
  let result: ParseResult | undefined;
  expect(() => {
    result = parse(source, options);
  }).not.toThrow();
  expect(result).toBeDefined();
  if (result!.ok) {
    assertTreeIntegrity(result!.rootNode, source);
  } else {
    expect(result!).toEqual({ ok: false, reason: 'aborted' });
  }
  return result!;
}

const TOKEN_POOL = [
  'echo', 'ls', 'foo', 'bar', 'x', 'A=1', 'if', 'then', 'fi', 'while', 'do', 'done', 'for', 'in', 'case', 'esac',
  '&&', '||', '|', '|&', ';', '&', ';;', ';&', '(', ')', '{', '}', '>', '>>', '<', '>&1', '2>', '&>', '<<EOF',
  '<<<', '$x', '${v}', '${v:-d}', '$(cmd)', '`cmd`', '$((1+2))', '[[', ']]', '[', ']', '==', '=~', '-f', '-z',
  '"str"', "'raw'", '$"t"', "$'a'", '*', '?', '[a-z]', '@(a|b)', '\\\\', '\\n', '\n', '#c', 'function', 'return',
  '${v#p}', '${v/p/r}', '${v[@]}', '!<', '>(p)', '<(p)', '$#', '$?', '0x1F', '..', '<<-', '>&-', 'abc_def',
] as const;

function fixtureSources(): string[] {
  const dir = path.join(PKG_ROOT, 'test/fixtures/differential');
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt')).toSorted()) {
    for (const sample of parseFixtureFile(file, readFileSync(path.join(dir, file), 'utf8'))) {
      out.push(sample.source);
    }
  }
  return out;
}

describe('fuzz: token soup', () => {
  it('never throws and always yields a sound tree or a clean abort', () => {
    const rand = prng(0x5eed0001);
    const count = 250 * SCALE;
    let parsed = 0;
    for (let n = 0; n < count; n++) {
      const length = 3 + Math.floor(rand() * 22);
      const parts: string[] = [];
      for (let k = 0; k < length; k++) parts.push(pick(rand, TOKEN_POOL));
      if (checkContract(parts.join(' ')).ok) parsed++;
    }
    expect(parsed).toBeGreaterThan(0);
    console.log(`token soup: ${count} inputs, ${parsed} parsed / ${count - parsed} aborted`);
  });
});

describe('fuzz: byte mutations of fixtures', () => {
  it('never throws and always yields a sound tree or a clean abort', () => {
    const rand = prng(0x5eed0002);
    const bases = fixtureSources();
    const count = 300 * SCALE;
    let parsed = 0;
    for (let n = 0; n < count; n++) {
      const base = pick(rand, bases);
      if (base.length === 0) continue;
      const pos = Math.floor(rand() * base.length);
      const mode = rand();
      let mutated: string;
      if (mode < 0.4) {
        // replace one code unit (may be NUL)
        const code = Math.floor(rand() * 256);
        mutated = base.slice(0, pos) + String.fromCodePoint(code) + base.slice(pos + 1);
      } else if (mode < 0.7) {
        mutated = base.slice(0, pos) + base.slice(pos + 1);
      } else {
        const code = Math.floor(rand() * 256);
        mutated = base.slice(0, pos) + String.fromCodePoint(code) + base.slice(pos);
      }
      if (checkContract(mutated).ok) parsed++;
    }
    expect(parsed).toBeGreaterThan(0);
    console.log(`byte mutations: ${count} inputs, ${parsed} parsed / ${count - parsed} aborted`);
  });
});

describe('fuzz: nesting bombs degrade locally per the documented depth caps', () => {
  const substitution = (depth: number): string => `echo ${'$('.repeat(depth)}x${')'.repeat(depth)}`;
  const subshell = (depth: number): string => `${'('.repeat(depth)}x${')'.repeat(depth)}`;
  const expansion = (depth: number): string => `echo ${'${a:-'.repeat(depth)}z${'}'.repeat(depth)}`;
  const ifs = (depth: number): string => `${'if x; then '.repeat(depth)}y${'; fi'.repeat(depth)}`;

  it('within the caps the trees are clean', () => {
    // literalDepth ticks twice per ${…} level (parseLiteral + parseExpansion),
    // so 200 levels stay under MAX_PARSE_DEPTH = 500.
    for (const source of [substitution(100), subshell(400), expansion(200), ifs(400)]) {
      const result = checkContract(source, { timeoutMs: 60_000 });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.hasError).toBe(false);
    }
  });

  it('beyond the caps the parse still succeeds and flags hasError (MAX_SUBSTITUTION_DEPTH = 150)', () => {
    const result = checkContract(substitution(200));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasError).toBe(true);
  });

  it('beyond the caps the parse still succeeds and flags hasError (MAX_PARSE_DEPTH = 500)', () => {
    for (const source of [subshell(600), expansion(600), ifs(600)]) {
      const result = checkContract(source, { timeoutMs: 60_000 });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.hasError).toBe(true);
    }
  });

  it('extreme nesting never overflows the stack', () => {
    for (const source of [substitution(5000), subshell(5000), expansion(5000), ifs(5000)]) {
      const result = checkContract(source, { timeoutMs: 60_000 });
      // Either a locally degraded tree (hasError) or a clean budget abort.
      if (result.ok) expect(result.hasError).toBe(true);
      else expect(result.reason).toBe('aborted');
    }
  });

  it('the node budget aborts huge flat programs, and a raised budget parses them', () => {
    const source = 'echo a; '.repeat(20_000);
    expect(parse(source)).toEqual({ ok: false, reason: 'aborted' });
    const result = parse(source, { timeoutMs: 60_000, maxNodes: 10_000_000 });
    expect(result.ok).toBe(true);
    if (result.ok) assertTreeIntegrity(result.rootNode, source);
  });
});

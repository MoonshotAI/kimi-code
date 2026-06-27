import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  nativeGlobMatchesAny,
  nativeGrepStructured,
} from '@moonshot-ai/kimi-native-tools';

// ── TS reference implementation (copied from fsSearchService.ts L668-693) ──
// Used as the parity baseline. Not exported from the source module, so we
// reproduce it here verbatim to avoid modifying production code for tests.
function globToRegExp(glob: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (glob[i] === '/') i++;
    } else if (ch === '*') {
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

function tsMatchesAnyGlob(rel: string, globs: readonly string[]): boolean {
  for (const g of globs) {
    if (globToRegExp(g).test(rel)) return true;
  }
  return false;
}

// ── Glob cross-language parity ─────────────────────────────────────────────

describe('nativeGlobMatchesAny — cross-language parity with globToRegExp', () => {
  // Cases where Rust (globset) and TS (globToRegExp) MUST agree.
  // Covers the common glob features: *, **, ?, literal paths, escapes.
  const parityCases: Array<{ glob: string; path: string; expected: boolean; note?: string }> = [
    { glob: '*.ts', path: 'foo.ts', expected: true, note: 'basic suffix match' },
    { glob: '*.ts', path: 'foo.tsx', expected: false, note: 'suffix mismatch' },
    { glob: '*.ts', path: 'src/foo.ts', expected: false, note: '* does not cross /' },
    { glob: '**/*.ts', path: 'src/a/b.ts', expected: true, note: '** crosses dirs' },
    { glob: '**/*.ts', path: 'foo.ts', expected: true, note: '** matches zero segments' },
    { glob: 'src/**', path: 'src/a/b.ts', expected: true, note: '** matches multiple segments' },
    { glob: 'src/**', path: 'test/a.ts', expected: false, note: 'not under src/' },
    { glob: '?.ts', path: 'a.ts', expected: true, note: '? matches single char' },
    { glob: '?.ts', path: 'ab.ts', expected: false, note: '? matches exactly one' },
    { glob: 'src/*.ts', path: 'src/a.ts', expected: true, note: 'prefix + wildcard' },
    { glob: '*.spec.ts', path: 'foo.spec.ts', expected: true, note: 'double suffix' },
    { glob: '*.spec.ts', path: 'foo.test.ts', expected: false, note: 'suffix mismatch' },
    { glob: '*', path: 'foo.txt', expected: true, note: 'any single-segment file' },
    { glob: '*', path: 'src/foo.txt', expected: false, note: '* does not cross /' },
    { glob: 'src/*', path: 'src', expected: false, note: '* needs at least one char after /' },
    { glob: '**', path: 'anything/here', expected: true, note: '** matches everything' },
    { glob: '**', path: 'anything', expected: true, note: '** matches single segment' },
    { glob: 'src/**/*.ts', path: 'src/a/b/c.ts', expected: true, note: 'deeply nested' },
    { glob: 'src/**/*.ts', path: 'src/c.ts', expected: true, note: '** matches zero segments mid-path' },
    { glob: '*.ts', path: 'foo.TS', expected: false, note: 'case-sensitive (no match)' },
    { glob: 'foo bar.ts', path: 'foo bar.ts', expected: true, note: 'spaces in name' },
    { glob: 'foo-bar.ts', path: 'foo-bar.ts', expected: true, note: 'hyphen in name' },
    { glob: 'a/b/c.ts', path: 'a/b/c.ts', expected: true, note: 'literal nested path' },
    { glob: 'a/b/c.ts', path: 'a/b/d.ts', expected: false, note: 'literal path mismatch' },
  ];

  for (const { glob, path, expected, note } of parityCases) {
    it(`matches ${JSON.stringify(glob)} vs ${JSON.stringify(path)} → ${expected} (${note})`, () => {
      const rustResult = nativeGlobMatchesAny([glob], path);
      const tsResult = tsMatchesAnyGlob(path, [glob]);
      expect(rustResult).toBe(expected);
      expect(tsResult).toBe(expected);
      expect(rustResult).toBe(tsResult);
    });
  }

  // Cases where Rust (globset) and TS (globToRegExp) intentionally DIFFER.
  // globset supports brace expansion {a,b} and character classes [abc];
  // globToRegExp treats them as literals. The Rust path is consistent with
  // ripgrep's --glob flag (which also uses globset), so this is an improvement,
  // not a regression. Documented here so future readers understand the delta.
  const knownDifferenceCases: Array<{ glob: string; path: string; rustExpected: boolean; tsExpected: boolean; note: string }> = [
    {
      glob: '*.{ts,tsx}',
      path: 'foo.tsx',
      rustExpected: true,
      tsExpected: false,
      note: 'brace expansion: globset expands {ts,tsx}; globToRegExp treats {} as literal',
    },
    {
      glob: '*.{ts,tsx}',
      path: 'foo.ts',
      rustExpected: true,
      tsExpected: false,
      note: 'brace expansion: globset matches foo.ts',
    },
    {
      glob: '*.{ts,tsx}',
      path: 'foo.js',
      rustExpected: false,
      tsExpected: false,
      note: 'brace expansion: neither matches foo.js',
    },
    {
      glob: '[abc].ts',
      path: 'a.ts',
      rustExpected: true,
      tsExpected: false,
      note: 'character class: globset matches a; globToRegExp treats [] as literal',
    },
    {
      glob: '[abc].ts',
      path: 'd.ts',
      rustExpected: false,
      tsExpected: false,
      note: 'character class: neither matches d.ts',
    },
  ];

  for (const { glob, path, rustExpected, tsExpected, note } of knownDifferenceCases) {
    it(`KNOWN DIFFERENCE ${JSON.stringify(glob)} vs ${JSON.stringify(path)} — rust=${rustExpected}, ts=${tsExpected} (${note})`, () => {
      const rustResult = nativeGlobMatchesAny([glob], path);
      const tsResult = tsMatchesAnyGlob(path, [glob]);
      expect(rustResult).toBe(rustExpected);
      expect(tsResult).toBe(tsExpected);
    });
  }

  it('multiple globs: matches if ANY pattern matches (Rust)', () => {
    expect(nativeGlobMatchesAny(['*.ts', '*.tsx', '*.js'], 'foo.tsx')).toBe(true);
    expect(nativeGlobMatchesAny(['*.ts', '*.tsx', '*.js'], 'foo.py')).toBe(false);
  });

  it('multiple globs: Rust and TS agree when no brace/char-class patterns', () => {
    const globs = ['*.ts', '*.tsx', 'src/**/*.js'];
    expect(nativeGlobMatchesAny(globs, 'src/a/b.js')).toBe(tsMatchesAnyGlob('src/a/b.js', globs));
    expect(nativeGlobMatchesAny(globs, 'foo.py')).toBe(tsMatchesAnyGlob('foo.py', globs));
  });
});

// ── Structured grep behavior ───────────────────────────────────────────────

describe('nativeGrepStructured — behavior verification', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kimi-grep-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string): string {
    const full = join(tmpDir, rel);
    const dir = full.substring(0, full.lastIndexOf('\\') >= 0 ? full.lastIndexOf('\\') : full.lastIndexOf('/'));
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    writeFileSync(full, content, 'utf-8');
    return rel.replace(/\\/g, '/');
  }

  /** Object-based wrapper around the positional nativeGrepStructured binding. */
  async function grep(opts: {
    pattern: string;
    path: string;
    literal: boolean;
    caseInsensitive: boolean;
    includeGlobs?: string[];
    excludeGlobs?: string[];
    contextLines: number;
    maxFiles: number;
    maxMatchesPerFile: number;
    maxTotalMatches: number;
    timeoutMs: number;
    followGitignore?: boolean;
  }) {
    return nativeGrepStructured(
      opts.pattern,
      opts.path,
      opts.literal,
      opts.caseInsensitive,
      opts.includeGlobs ?? [],
      opts.excludeGlobs ?? [],
      opts.contextLines,
      opts.maxFiles,
      opts.maxMatchesPerFile,
      opts.maxTotalMatches,
      opts.timeoutMs,
      opts.followGitignore ?? true,
    );
  }

  it('literal match — returns line/col/text', async () => {
    writeFile('a.ts', 'line one\nconst TODO = "fixme";\nline three\n');
    const result = await grep({
      pattern: 'TODO',
      path: tmpDir,
      literal: true,
      caseInsensitive: false,
      contextLines: 0,
      maxFiles: 50,
      maxMatchesPerFile: 10,
      maxTotalMatches: 100,
      timeoutMs: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.files.length).toBe(1);
    const hit = result.files[0]!;
    expect(hit.path).toBe('a.ts');
    expect(hit.matches.length).toBe(1);
    const m = hit.matches[0]!;
    expect(m.line).toBe(2);
    expect(m.col).toBe(7);
    expect(m.text).toContain('TODO');
    expect(m.before).toEqual([]);
    expect(m.after).toEqual([]);
  });

  it('regex mode — alternation pattern', async () => {
    writeFile('a.ts', 'const TODO = 1;\nconst FIXME = 2;\n');
    const result = await grep({
      pattern: 'TODO|FIXME',
      path: tmpDir,
      literal: false,
      caseInsensitive: false,
      contextLines: 0,
      maxFiles: 50,
      maxMatchesPerFile: 10,
      maxTotalMatches: 100,
      timeoutMs: 5000,
    });
    expect(result.files.length).toBe(1);
    const hit = result.files[0]!;
    expect(hit.matches.length).toBe(2);
    expect(hit.matches[0]!.line).toBe(1);
    expect(hit.matches[0]!.text).toContain('TODO');
    expect(hit.matches[1]!.line).toBe(2);
    expect(hit.matches[1]!.text).toContain('FIXME');
  });

  it('case_insensitive — uppercase pattern matches lowercase content', async () => {
    writeFile('a.ts', 'const todo = 1;\n');
    const result = await grep({
      pattern: 'TODO',
      path: tmpDir,
      literal: true,
      caseInsensitive: true,
      contextLines: 0,
      maxFiles: 50,
      maxMatchesPerFile: 10,
      maxTotalMatches: 100,
      timeoutMs: 5000,
    });
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.matches[0]!.text).toContain('todo');
  });

  it('context_lines=2 — before and after context collected', async () => {
    writeFile('a.ts', 'line1\nline2\nMATCH\nline4\nline5\n');
    const result = await grep({
      pattern: 'MATCH',
      path: tmpDir,
      literal: true,
      caseInsensitive: false,
      contextLines: 2,
      maxFiles: 50,
      maxMatchesPerFile: 10,
      maxTotalMatches: 100,
      timeoutMs: 5000,
    });
    const m = result.files[0]!.matches[0]!;
    expect(m.line).toBe(3);
    expect(m.before).toEqual(['line1', 'line2']);
    expect(m.after).toEqual(['line4', 'line5']);
  });

  it('include_globs — only scans matching files', async () => {
    writeFile('a.ts', 'TODO\n');
    writeFile('b.js', 'TODO\n');
    const result = await grep({
      pattern: 'TODO',
      path: tmpDir,
      literal: true,
      caseInsensitive: false,
      includeGlobs: ['*.ts'],
      contextLines: 0,
      maxFiles: 50,
      maxMatchesPerFile: 10,
      maxTotalMatches: 100,
      timeoutMs: 5000,
    });
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('a.ts');
  });

  it('exclude_globs — skips matching files', async () => {
    writeFile('a.ts', 'TODO\n');
    writeFile('a.test.ts', 'TODO\n');
    const result = await grep({
      pattern: 'TODO',
      path: tmpDir,
      literal: true,
      caseInsensitive: false,
      excludeGlobs: ['*.test.ts'],
      contextLines: 0,
      maxFiles: 50,
      maxMatchesPerFile: 10,
      maxTotalMatches: 100,
      timeoutMs: 5000,
    });
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('a.ts');
  });

  it('max_matches_per_file — caps matches per file', async () => {
    writeFile('a.ts', 'TODO\nTODO\nTODO\nTODO\n');
    const result = await grep({
      pattern: 'TODO',
      path: tmpDir,
      literal: true,
      caseInsensitive: false,
      contextLines: 0,
      maxFiles: 50,
      maxMatchesPerFile: 2,
      maxTotalMatches: 100,
      timeoutMs: 5000,
    });
    expect(result.files[0]!.matches.length).toBe(2);
  });

  it('truncated — max_total_matches sets truncated flag', async () => {
    writeFile('a.ts', 'TODO\nTODO\nTODO\nTODO\nTODO\n');
    writeFile('b.ts', 'TODO\nTODO\nTODO\nTODO\nTODO\n');
    const result = await grep({
      pattern: 'TODO',
      path: tmpDir,
      literal: true,
      caseInsensitive: false,
      contextLines: 0,
      maxFiles: 50,
      maxMatchesPerFile: 100,
      maxTotalMatches: 3,
      timeoutMs: 5000,
    });
    expect(result.truncated).toBe(true);
    let total = 0;
    for (const f of result.files) total += f.matches.length;
    expect(total).toBeLessThanOrEqual(3);
  });

  it('no matches — returns empty files array', async () => {
    writeFile('a.ts', 'nothing here\n');
    const result = await grep({
      pattern: 'TODO',
      path: tmpDir,
      literal: true,
      caseInsensitive: false,
      contextLines: 0,
      maxFiles: 50,
      maxMatchesPerFile: 10,
      maxTotalMatches: 100,
      timeoutMs: 5000,
    });
    expect(result.files.length).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('invalid regex — returns error without throwing', async () => {
    writeFile('a.ts', 'content\n');
    const result = await grep({
      pattern: '[invalid',
      path: tmpDir,
      literal: false,
      caseInsensitive: false,
      contextLines: 0,
      maxFiles: 50,
      maxMatchesPerFile: 10,
      maxTotalMatches: 100,
      timeoutMs: 5000,
    });
    expect(result.error).toBeDefined();
    expect(result.files.length).toBe(0);
  });
});

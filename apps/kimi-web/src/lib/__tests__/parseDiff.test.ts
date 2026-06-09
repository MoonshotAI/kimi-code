// apps/kimi-web/src/lib/__tests__/parseDiff.test.ts
import { describe, expect, it } from 'vitest';
import { parseDiff } from '../parseDiff';

describe('parseDiff', () => {
  it('returns [] for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('parses a single hunk with add / del / context lines', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      'index 1111111..2222222 100644',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 4;',
      '',
    ].join('\n');

    const lines = parseDiff(diff);
    // hunk + 4 content lines (file headers skipped)
    expect(lines.map((l) => l.type)).toEqual([
      'hunk',
      'context',
      'del',
      'add',
      'context',
    ]);
    expect(lines[1]).toEqual({ type: 'context', text: 'const a = 1;', oldNo: 1, newNo: 1 });
    expect(lines[2]).toEqual({ type: 'del', text: 'const b = 2;', oldNo: 2 });
    expect(lines[3]).toEqual({ type: 'add', text: 'const b = 3;', newNo: 2 });
    expect(lines[4]).toEqual({ type: 'context', text: 'const c = 4;', oldNo: 3, newNo: 3 });
  });

  it('skips all file headers (diff --git / index / --- / +++)', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      'index abc..def 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const lines = parseDiff(diff);
    expect(lines.find((l) => l.text.startsWith('diff --git'))).toBeUndefined();
    expect(lines.find((l) => l.text.startsWith('index'))).toBeUndefined();
    expect(lines.find((l) => l.text === '--- a/x.ts')).toBeUndefined();
    expect(lines.find((l) => l.text === '+++ b/x.ts')).toBeUndefined();
    expect(lines.map((l) => l.type)).toEqual(['hunk', 'del', 'add']);
  });

  it('parses the hunk header text and resets line counters', () => {
    const diff = ['@@ -10,2 +20,2 @@ func foo()', ' ctx', '+added'].join('\n');
    const lines = parseDiff(diff);
    expect(lines[0]).toEqual({ type: 'hunk', text: '@@ -10,2 +20,2 @@ func foo()' });
    expect(lines[1]).toEqual({ type: 'context', text: 'ctx', oldNo: 10, newNo: 20 });
    expect(lines[2]).toEqual({ type: 'add', text: 'added', newNo: 21 });
  });

  it('handles multiple hunks in one file', () => {
    const diff = [
      'diff --git a/m.ts b/m.ts',
      '--- a/m.ts',
      '+++ b/m.ts',
      '@@ -1,1 +1,1 @@',
      '-first-old',
      '+first-new',
      '@@ -10,1 +10,1 @@',
      '-second-old',
      '+second-new',
    ].join('\n');
    const lines = parseDiff(diff);
    const hunks = lines.filter((l) => l.type === 'hunk');
    expect(hunks).toHaveLength(2);
    // second hunk's line numbers come from its own header
    const secondDel = lines.find((l) => l.text === 'second-old');
    expect(secondDel).toEqual({ type: 'del', text: 'second-old', oldNo: 10 });
  });

  it('handles multiple files (next diff --git ends the previous hunk)', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a-old',
      '+a-new',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-b-old',
      '+b-new',
    ].join('\n');
    const lines = parseDiff(diff);
    expect(lines.filter((l) => l.type === 'hunk')).toHaveLength(2);
    expect(lines.filter((l) => l.type === 'add').map((l) => l.text)).toEqual([
      'a-new',
      'b-new',
    ]);
    expect(lines.filter((l) => l.type === 'del').map((l) => l.text)).toEqual([
      'a-old',
      'b-old',
    ]);
  });

  it('skips the "No newline at end of file" marker', () => {
    const diff = [
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');
    const lines = parseDiff(diff);
    expect(lines.map((l) => l.type)).toEqual(['hunk', 'del', 'add']);
  });

  it('preserves a context line that is itself empty (leading space marker)', () => {
    const diff = ['@@ -1,2 +1,2 @@', ' ', '+added'].join('\n');
    const lines = parseDiff(diff);
    expect(lines[1]).toEqual({ type: 'context', text: '', oldNo: 1, newNo: 1 });
  });
});

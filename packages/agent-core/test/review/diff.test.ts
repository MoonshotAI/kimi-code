import { describe, expect, it } from 'vitest';

import { anchorHunkHeader, fileDiffForPath, parseUnifiedDiff } from '../../src/review/diff';

const SAMPLE = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' const d = 5',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('parses files, hunks, and per-side line numbers', () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.path).toBe('src/foo.ts');
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0]!;
    expect(hunk.header).toBe('@@ -1,3 +1,4 @@');
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);

    const add = hunk.lines.find((line) => line.kind === 'add' && line.text === 'const b = 3');
    expect(add?.newLine).toBe(2);
    expect(add?.oldLine).toBeUndefined();

    const del = hunk.lines.find((line) => line.kind === 'del');
    expect(del?.oldLine).toBe(2);

    const context = hunk.lines.find((line) => line.text === 'const d = 5');
    expect(context).toMatchObject({ kind: 'context', oldLine: 3, newLine: 4 });
  });

  it('handles renames via the rename header and old path', () => {
    const renamed = [
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 90%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(renamed);
    expect(files[0]?.path).toBe('new/name.ts');
    expect(fileDiffForPath(files, 'old/name.ts')).toBe(files[0]);
  });

  it('parses added files against /dev/null', () => {
    const added = [
      'diff --git a/added.txt b/added.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/added.txt',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(added);
    expect(files[0]?.path).toBe('added.txt');
    expect(files[0]?.oldPath).toBeUndefined();
    expect(files[0]?.hunks[0]?.lines.map((line) => line.newLine)).toEqual([1, 2]);
  });
});

describe('anchorHunkHeader', () => {
  it('returns the hunk header covering a new-side line', () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(anchorHunkHeader(files[0], 'new', 2)).toBe('@@ -1,3 +1,4 @@');
    expect(anchorHunkHeader(files[0], 'new', 4)).toBe('@@ -1,3 +1,4 @@');
  });

  it('returns undefined when the line is outside any hunk', () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(anchorHunkHeader(files[0], 'new', 999)).toBeUndefined();
    expect(anchorHunkHeader(undefined, 'new', 1)).toBeUndefined();
  });
});

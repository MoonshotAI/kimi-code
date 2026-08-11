import { describe, expect, it } from 'vitest';

import { parseDiff } from '../src/client';
import {
  buildFullDiffTexts,
  MAX_FULL_DIFF_LINES,
  MAX_HIGHLIGHT_CHARS,
  reconstructOldText,
} from '../src/client';

const MODIFIED_DIFF = [
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B2',
  ' c',
  '@@ -6,3 +6,3 @@',
  ' f',
  '-g',
  '+G2',
  ' h',
].join('\n');
const MODIFIED_NEW = ['a', 'B2', 'c', 'd', 'e', 'f', 'G2', 'h'].join('\n');
const MODIFIED_OLD = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');

describe('reconstructOldText', () => {
  it('rebuilds the old file across multiple hunks, copying the gap from the new text', () => {
    expect(reconstructOldText(parseDiff(MODIFIED_DIFF), MODIFIED_NEW)).toBe(MODIFIED_OLD);
  });

  it('returns an empty old text for a new file (@@ -0,0 @@)', () => {
    const diff = '@@ -0,0 +1,2 @@\n+one\n+two';
    expect(reconstructOldText(parseDiff(diff), 'one\ntwo')).toBe('');
  });

  it('rebuilds a deleted file from an empty new text (@@ +0,0 @@)', () => {
    const diff = '@@ -1,2 +0,0 @@\n-one\n-two';
    expect(reconstructOldText(parseDiff(diff), '')).toBe('one\ntwo');
  });

  it('handles zero-count hunk targets (pure insertion and pure deletion)', () => {
    const ins = '@@ -2,0 +3,2 @@\n+P\n+Q';
    expect(reconstructOldText(parseDiff(ins), 'x\ny\nP\nQ\nz')).toBe('x\ny\nz');
    const del = '@@ -3,2 +2,0 @@\n-D1\n-D2';
    expect(reconstructOldText(parseDiff(del), 'x\ny\nz')).toBe('x\ny\nD1\nD2\nz');
  });

  it('returns null when the working tree moved on after the diff was taken', () => {
    const moved = ['a', 'WRONG', 'c', 'd', 'e', 'f', 'G2', 'h'].join('\n');
    expect(reconstructOldText(parseDiff(MODIFIED_DIFF), moved)).toBeNull();
  });

  it('returns null for rows without line numbers (verbatim markers)', () => {
    expect(reconstructOldText([{ type: 'context', text: '… 5 more lines …' }], 'x')).toBeNull();
  });
});

describe('buildFullDiffTexts', () => {
  it('returns both sides for a modified file', async () => {
    const texts = await buildFullDiffTexts(parseDiff(MODIFIED_DIFF), {
      truncated: false,
      readNewText: async () => MODIFIED_NEW,
    });
    expect(texts).toEqual({ before: MODIFIED_OLD, after: MODIFIED_NEW });
  });

  it('treats an unreadable new side as deleted (empty after)', async () => {
    const diff = '@@ -1,2 +0,0 @@\n-one\n-two';
    const texts = await buildFullDiffTexts(parseDiff(diff), {
      truncated: false,
      readNewText: async () => null,
    });
    expect(texts).toEqual({ before: 'one\ntwo', after: '' });
  });

  it('bails without reading when the diff was truncated server-side', async () => {
    const texts = await buildFullDiffTexts(parseDiff(MODIFIED_DIFF), {
      truncated: true,
      readNewText: () => Promise.reject(new Error('must not be called')),
    });
    expect(texts).toBeNull();
  });

  it('bails when either side exceeds the line cap', async () => {
    const huge = Array.from({ length: MAX_FULL_DIFF_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    const texts = await buildFullDiffTexts(parseDiff(MODIFIED_DIFF), {
      truncated: false,
      readNewText: async () => huge,
    });
    expect(texts).toBeNull();
  });

  it('bails when either side exceeds the char budget (minified blob)', async () => {
    const huge = `const x=${'x'.repeat(MAX_HIGHLIGHT_CHARS)};`;
    const texts = await buildFullDiffTexts(parseDiff(MODIFIED_DIFF), {
      truncated: false,
      readNewText: async () => huge,
    });
    expect(texts).toBeNull();
  });

  it('bails when reconstruction fails (stale diff)', async () => {
    const texts = await buildFullDiffTexts(parseDiff(MODIFIED_DIFF), {
      truncated: false,
      readNewText: async () => 'completely\nother\nfile',
    });
    expect(texts).toBeNull();
  });
});

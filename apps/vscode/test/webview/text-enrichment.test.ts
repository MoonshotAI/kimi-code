import { describe, expect, it } from 'vitest';
import { extractPaths, parseSegments } from '@/lib/text-enrichment';

describe('text enrichment file paths', () => {
  it('keeps a line suffix on the clickable path', () => {
    expect(parseSegments('see src/app.ts:42 now', { 'src/app.ts': true })).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'file', value: 'src/app.ts:42', path: 'src/app.ts:42' },
      { type: 'text', value: ' now' },
    ]);
  });

  it('keeps a line and column suffix on the clickable path', () => {
    expect(parseSegments('src/app.ts:42:7', { 'src/app.ts': true })).toEqual([
      { type: 'file', value: 'src/app.ts:42:7', path: 'src/app.ts:42:7' },
    ]);
  });

  it('checks existence against the path without the suffix', () => {
    expect(parseSegments('src/app.ts:42', { 'src/app.ts:42': true })).toEqual([
      { type: 'text', value: 'src/app.ts:42' },
    ]);
  });

  it('leaves a missing file as text while keeping the suffix', () => {
    expect(parseSegments('src/missing.ts:42', {})).toEqual([
      { type: 'text', value: 'src/missing.ts:42' },
    ]);
  });

  it('strips the line suffix before the existence check', () => {
    expect(extractPaths('src/app.ts:42 and src/app.ts:12:7')).toEqual(['src/app.ts']);
  });

  it('still extracts plain paths', () => {
    expect(extractPaths('@src/app.ts')).toEqual(['src/app.ts']);
  });
});

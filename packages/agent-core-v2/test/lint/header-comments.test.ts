/**
 * Header-only-comment gate — the package AGENTS.md "Comment conventions"
 * section requires comments to live solely in the top-of-file block, never
 * beside functions, methods, or statements. This probe guards files that
 * previously attracted review findings for inline implementation narration;
 * extend the list when a file newly trades in subtle encoding or matching
 * rules that tempt an explanatory comment.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(import.meta.dirname, '..', '..', 'src');

const HEADER_ONLY_FILES = ['tool/rule-match.ts'];

function commentLinesOutsideHeader(source: string): string[] {
  const headerEnd = source.indexOf('*/');
  const body = headerEnd === -1 ? source : source.slice(headerEnd + 2);
  return body
    .split('\n')
    .filter(
      (line) =>
        line.includes('//') || line.includes('/*') || line.trimStart().startsWith('*'),
    );
}

describe('header-only comments', () => {
  for (const file of HEADER_ONLY_FILES) {
    it(`${file} keeps comments inside the top-of-file header`, () => {
      const source = readFileSync(join(SRC_ROOT, file), 'utf8');
      expect(source.startsWith('/**')).toBe(true);
      expect(commentLinesOutsideHeader(source)).toEqual([]);
    });
  }
});

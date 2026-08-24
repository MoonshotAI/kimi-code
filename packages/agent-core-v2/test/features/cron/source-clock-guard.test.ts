import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const GUARDED_FILES = [
  { dir: 'features/cron', file: 'cronAgentRuntime.ts' },
  { dir: 'features/cron/internal', file: 'jitter.ts' },
] as const;

describe('cron source clock guard', () => {
  it.each(GUARDED_FILES)('$file does not call Date.now()', ({ dir, file }) => {
    const source = readFileSync(new URL(`../../../src/${dir}/${file}`, import.meta.url), 'utf8');
    expect(stripComments(source)).not.toMatch(/\bDate\.now\s*\(/);
  });
});

function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '');
}

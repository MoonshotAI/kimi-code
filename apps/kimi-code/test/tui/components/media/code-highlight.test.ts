import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { codeHighlightTheme } from '#/tui/theme/highlight-theme';
import { currentTheme } from '#/tui/theme/theme';

import { captureProcessWrite } from '../../../helpers/process';

const ESC = String.fromCodePoint(27);

describe('code-highlight', () => {
  it('maps known file extensions to supported highlight languages', () => {
    expect(langFromPath('src/foo.ts')).toBe('typescript');
    expect(langFromPath('src/foo.TS')).toBe('typescript');
  });

  it('treats unsupported file extensions as plain text', () => {
    expect(langFromPath('src/foo.abcxyz')).toBeUndefined();
  });

  it('does not call cli-highlight for unsupported languages', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      expect(highlightLines('hello\nworld', 'abcxyz')).toEqual(['hello', 'world']);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  it('resets string and regexp tokens to plain styling', () => {
    for (const token of ['string', 'regexp'] as const) {
      expect(codeHighlightTheme[token]?.('code')).toBe('code');
    }
  });

  it('emits no red SGR for strings and regexps', () => {
    // cli-highlight styles through its own chalk v4 instance; force colors on
    // so the assertions below observe real SGR sequences.
    const req = createRequire(import.meta.url);
    const chalkV4 = req(
      req.resolve('chalk', { paths: [dirname(req.resolve('cli-highlight'))] }),
    ) as { level: number };
    const prevLevel = chalkV4.level;
    chalkV4.level = 1;
    try {
      const js = highlightLines("const s = 'str';\nconst r = /re+/g;", 'javascript').join('\n');
      expect(js).not.toContain(`${ESC}[31m`);
      expect(js).toContain(`${ESC}[34m`); // keywords stay highlighted
    } finally {
      chalkV4.level = prevLevel;
    }
  });

  it('colors diff deletions and additions with the palette diff colors', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      expect(highlightLines('- removed\n+ added', 'diff')).toEqual([
        chalk.hex(currentTheme.color('diffRemoved'))('- removed'),
        chalk.hex(currentTheme.color('diffAdded'))('+ added'),
      ]);
    } finally {
      chalk.level = previousLevel;
    }
  });
});

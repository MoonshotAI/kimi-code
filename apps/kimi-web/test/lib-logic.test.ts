import { describe, expect, it } from 'vitest';
import {
  collectFilePathAliases,
  findFilePathLinks,
  parseFilePathLinkCandidate,
} from '../src/lib/filePathLinks';
import { escapeProseDollars } from '../src/lib/mathDelimiters';
import { parseDiff } from '../src/lib/parseDiff';
import { normalizeToolName, toolSummary } from '../src/lib/toolMeta';

describe('parseDiff', () => {
  it('parses multiple files and keeps hunk line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      'diff --git a/src/comment.sql b/src/comment.sql',
      '@@ -5,1 +5,1 @@',
      '--- old comment',
      '+++ new comment',
    ].join('\n');

    expect(parseDiff(diff)).toEqual([
      { type: 'hunk', text: '@@ -1,2 +1,3 @@' },
      { type: 'context', text: 'const a = 1;', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'const b = 2;', oldNo: 2 },
      { type: 'add', text: 'const b = 3;', newNo: 2 },
      { type: 'add', text: 'const c = 4;', newNo: 3 },
      { type: 'hunk', text: '@@ -5,1 +5,1 @@' },
      { type: 'del', text: '-- old comment', oldNo: 5 },
      { type: 'add', text: '++ new comment', newNo: 5 },
    ]);
  });
});

describe('filePathLinks', () => {
  it('rejects URLs and bare unknown filenames', () => {
    expect(parseFilePathLinkCandidate('https://example.com/a.ts')).toBeNull();
    expect(parseFilePathLinkCandidate('e2e-success.png')).toBeNull();
  });

  it('finds path links with line numbers and resolves aliases', () => {
    const aliases = collectFilePathAliases('<img src="/assets/demo.png">');
    expect(aliases.get('demo.png')).toBe('/assets/demo.png');

    expect(
      findFilePathLinks('Open src/a.ts#L12 and demo.png.', { aliases }),
    ).toMatchObject([
      { path: 'src/a.ts', line: 12, text: 'src/a.ts#L12' },
      { path: '/assets/demo.png', text: 'demo.png' },
    ]);
  });
});

describe('toolMeta', () => {
  it('normalizes common tool aliases', () => {
    expect(normalizeToolName('WebFetch')).toBe('web_fetch');
    expect(normalizeToolName('MultiEdit')).toBe('multi_edit');
    expect(normalizeToolName('TodoWrite')).toBe('todo');
    expect(normalizeToolName('rg')).toBe('grep');
  });

  it('summarizes tool arguments for card headers', () => {
    expect(
      toolSummary('Read', JSON.stringify({ path: 'src/a.ts', offset: 10, limit: 5 })),
    ).toBe('src/a.ts:10-15');
    expect(toolSummary('Read', '{}')).toBe('');
    expect(toolSummary('Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('pnpm test');
    expect(
      toolSummary('WebFetch', JSON.stringify({ url: 'https://example.com/path/to' })),
    ).toBe('example.com/path');
  });
});

describe('escapeProseDollars', () => {
  it('escapes literal-dollar prose so it is not parsed as math', () => {
    expect(escapeProseDollars('Check $PATH before $HOME')).toBe(
      'Check \\$PATH before \\$HOME',
    );
    expect(escapeProseDollars('costs $5 and $10')).toBe('costs \\$5 and \\$10');
    expect(escapeProseDollars('it costs $5')).toBe('it costs \\$5');
  });

  it('escapes compact prose currency ranges', () => {
    expect(escapeProseDollars('costs $5/$10 here')).toBe('costs \\$5/\\$10 here');
    expect(escapeProseDollars('costs $5-$10 here')).toBe('costs \\$5-\\$10 here');
    expect(escapeProseDollars('ranges from $1,000/$2,000 today')).toBe(
      'ranges from \\$1,000/\\$2,000 today',
    );
  });

  it('escapes shell variables and path-like values', () => {
    expect(escapeProseDollars('Use $HOME/bin:$PATH now')).toBe(
      'Use \\$HOME/bin:\\$PATH now',
    );
    expect(escapeProseDollars('echo $PATH:$HOME here')).toBe(
      'echo \\$PATH:\\$HOME here',
    );
    expect(escapeProseDollars('var $foo_$bar x')).toBe('var \\$foo_\\$bar x');
  });

  it('preserves a real formula that follows a prose dollar', () => {
    // The prose `$` must not steal the formula's opening `$`.
    expect(escapeProseDollars('costs $5 and formula $x$')).toBe(
      'costs \\$5 and formula $x$',
    );
    expect(escapeProseDollars('Use $HOME before $E=mc^2$')).toBe(
      'Use \\$HOME before $E=mc^2$',
    );
    expect(escapeProseDollars('price $5 then $x^2$ done')).toBe(
      'price \\$5 then $x^2$ done',
    );
    expect(escapeProseDollars('$5 and $10 and $x$')).toBe('\\$5 and \\$10 and $x$');
  });

  it('leaves real inline and block math untouched', () => {
    expect(escapeProseDollars('$E=mc^2$')).toBe('$E=mc^2$');
    expect(escapeProseDollars('Einstein $E=mc^2$ famous')).toBe(
      'Einstein $E=mc^2$ famous',
    );
    expect(escapeProseDollars('inline $\\frac{1}{2}$ math')).toBe(
      'inline $\\frac{1}{2}$ math',
    );
    expect(escapeProseDollars('$A$ and $B$')).toBe('$A$ and $B$');
    expect(escapeProseDollars('rate $5/2$ per unit')).toBe('rate $5/2$ per unit');
    expect(escapeProseDollars('$$a^2 + b^2 = c^2$$')).toBe('$$a^2 + b^2 = c^2$$');
  });

  it('leaves math next to punctuation, brackets, and CJK untouched', () => {
    expect(escapeProseDollars('equals $x^2$. today')).toBe('equals $x^2$. today');
    expect(escapeProseDollars('see ($x^2$) here')).toBe('see ($x^2$) here');
    expect(escapeProseDollars('公式为 $E=mc^2$，其中')).toBe('公式为 $E=mc^2$，其中');
    expect(escapeProseDollars('中文 $x^2$。')).toBe('中文 $x^2$。');
    expect(escapeProseDollars('“$x$”')).toBe('“$x$”');
    expect(escapeProseDollars('公式$E=mc^2$表明')).toBe('公式$E=mc^2$表明');
  });

  it('does not touch dollars inside code spans or fenced code', () => {
    expect(escapeProseDollars('code `$5 and $10` here')).toBe('code `$5 and $10` here');
    expect(escapeProseDollars('use `$HOME` var')).toBe('use `$HOME` var');
    const fenced = '```\n$5 and $10\n```';
    expect(escapeProseDollars(fenced)).toBe(fenced);
  });

  it('does not touch dollars inside indented code blocks', () => {
    // A 4-space indented line is a code block; the dollar must stay literal.
    expect(escapeProseDollars('    echo $HOME')).toBe('    echo $HOME');
    const block = 'before\n\n    echo $HOME\n    echo $PATH\n\nafter';
    expect(escapeProseDollars(block)).toBe(block);
    // Tab-indented code is protected too.
    expect(escapeProseDollars('\techo $HOME')).toBe('\techo $HOME');
  });

  it('does not treat a 4-space list continuation as an indented code block', () => {
    // Inside a list item a 4-space indent is continuation prose (code under a
    // list marker needs deeper indentation), so the price range is escaped.
    expect(escapeProseDollars('- total\n    costs $5 and $10')).toBe(
      '- total\n    costs \\$5 and \\$10',
    );
  });

  it('does not double-escape already-escaped dollars', () => {
    expect(escapeProseDollars('literal \\$5 here')).toBe('literal \\$5 here');
  });
});

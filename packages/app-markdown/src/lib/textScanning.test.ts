import { describe, expect, it } from 'vitest';
import { codeFences, splitDiffFences } from './codeFences';
import { imageSources, rewriteImageSources } from './imageSources';
import { findFilePathLinks, isRelativeLinkCandidate } from './filePathLinks';
import { createInlineMathMatcher, matchInlineMath } from './inlineMath';
import { markdownRenderPlan } from './markdownPerformance';

describe('bounded text scanning', () => {
  it.each([24, 100_000])('handles ambiguous comma-separated amounts (%i)', (count) => {
    const content = '1,'.repeat(count) + '1!';
    const started = performance.now();
    expect(matchInlineMath(`1$${content}$`, 1)?.content).toBe(content);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it.each(['a.', '/a'])('handles incomplete URL candidates (%s)', (pattern) => {
    const prefix = pattern.repeat(100_000);
    const text = `${prefix} $x$`;
    const started = performance.now();
    expect(createInlineMathMatcher(text)(prefix.length + 1)?.content).toBe('x');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('does not retry every bracket when linking paths', () => {
    const text = '['.repeat(200_000) + ' src/a.ts#L12';
    const started = performance.now();
    expect(findFilePathLinks(text).map(({ path, line }) => ({ path, line }))).toEqual([{ path: 'src/a.ts', line: 12 }]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('finds paths after suffixes and delimiters without duplicating overlapping candidates', () => {
    expect(findFilePathLinks('file.txtfile.txt:12.[src/a.tsfile.txt.').map(({ path }) => path)).toEqual(['src/a.tsfile.txt']);
    expect(findFilePathLinks('[~@file.txt]]src/a.ts)').map(({ path }) => path)).toEqual(['~@file.txt]]src/a.ts']);
  });

  it.each(['```js\nx\n', '```diff\nx\n'])('handles unclosed fences (%s)', (pattern) => {
    const text = pattern.repeat(25_000);
    const started = performance.now();
    expect(markdownRenderPlan(text)).toEqual({ renderCodeBlocksAsPre: true, codeFenceCount: 0, codeChars: 0 });
    expect(splitDiffFences(text)).toEqual([{ kind: 'md', text }]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('uses matching fence markers and ignores nested diff examples', () => {
    const text = 'before\n````md\n```diff\n+x\n```\n````\n~~~diff\n+y\n~~~\nafter';
    expect([...codeFences(text)]).toHaveLength(2);
    expect(splitDiffFences(text)).toEqual([
      { kind: 'md', text: 'before\n````md\n```diff\n+x\n```\n````\n' },
      { kind: 'diff', code: '+y' },
      { kind: 'md', text: '\nafter' },
    ]);
    expect(markdownRenderPlan('```ts\na\n\n```').codeChars).toBe(2);
    expect([...codeFences('```diff\nx\n~~~')]).toEqual([]);
    expect([...codeFences('```\n```')][0]?.contentEnd).toBe(4);
  });

  it.each(['!['.repeat(100_000), '![x](' + 'a'.repeat(200_000), '<img '.repeat(40_000)])('handles incomplete images (%#)', (text) => {
    const started = performance.now();
    expect(imageSources(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('rewrites only the image source spans and retains titles and attributes', () => {
    const text = '![x](  a.png "title") <IMG alt="x" src="b.png" width="2"> ![y](https://example.com/c.png)';
    const sources = imageSources(text);
    expect(sources.map(({ src }) => src)).toEqual(['a.png', 'b.png', 'https://example.com/c.png']);
    expect(rewriteImageSources(text, sources, (src) => src.startsWith('http') ? null : `/files/${src}`)).toBe(
      '![x](  /files/a.png "title") <IMG alt="x" src="/files/b.png" width="2"> ![y](https://example.com/c.png)',
    );
  });

  it('rewrites angle-bracketed image sources containing spaces', () => {
    const text = '![x](<KIMI CODE LOGO/Original Logo.png> "title")';
    const sources = imageSources(text);
    expect(sources.map(({ src }) => src)).toEqual(['KIMI CODE LOGO/Original Logo.png']);
    expect(rewriteImageSources(text, sources, (src) => `/files/${src}`)).toBe(
      '![x](</files/KIMI CODE LOGO/Original Logo.png> "title")',
    );
  });

  it('supports parentheses inside angle-bracketed image sources', () => {
    const text = '![x](<screenshots/Screenshot (1).png>)';
    const sources = imageSources(text);
    expect(sources.map(({ src }) => src)).toEqual(['screenshots/Screenshot (1).png']);
    expect(rewriteImageSources(text, sources, () => 'data:image/png;base64,AA')).toBe(
      '![x](<data:image/png;base64,AA>)',
    );
  });

  it('bounds scanning of unclosed angle-bracketed candidates', () => {
    const text = '![x](<)'.repeat(200_000);
    const started = performance.now();
    expect(imageSources(text)).toHaveLength(200_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('findFilePathLinks', () => {
  it.each([
    { text: 'Open /Users/user/projects/test dir/test.md now', path: '/Users/user/projects/test dir/test.md', line: undefined },
    { text: 'Open ./test dir/test file.md#L12 now', path: './test dir/test file.md', line: 12 },
    { text: 'Open ./test dir/Makefile now', path: './test dir/Makefile', line: undefined },
    { text: 'Open /tmp/two  spaces/file.md now', path: '/tmp/two  spaces/file.md', line: undefined },
    { text: 'Open /tmp/report final.md now', path: '/tmp/report final.md', line: undefined },
    { text: 'Open src/test dir/test.md now', path: 'src/test dir/test.md', line: undefined },
    { text: 'Open /tmp/Research and Development/report.md now', path: '/tmp/Research and Development/report.md', line: undefined },
  ])('supports spaces inside file paths ($path)', ({ text, path, line }) => {
    expect(findFilePathLinks(text).map((match) => ({ path: match.path, line: match.line }))).toEqual([{ path, line }]);
  });

  it.each([
    { text: 'Compare /src/old dir/a.ts and /src/new dir/b.ts now', paths: ['/src/old dir/a.ts', '/src/new dir/b.ts'] },
    { text: 'Compare src/old dir/a.ts and src/new dir/b.ts now', paths: ['src/old dir/a.ts', 'src/new dir/b.ts'] },
  ])('finds multiple paths with spaces without linking the surrounding prose (%s)', ({ text, paths }) => {
    expect(findFilePathLinks(text).map(({ path }) => path)).toEqual(paths);
  });

  it.each([
    'Compare src/main.py and src/bar.ts',
    'See src/foo and README.md',
    'Compare /src/main.py and /src/bar.ts',
    'See /src/foo and README.md',
    'Choose src/foo or README.md',
  ])('does not merge an invalid path with the next valid path (%s)', (text) => {
    const matches = findFilePathLinks(text).map(({ path }) => path);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/(?:bar\.ts|README\.md)$/);
    expect(matches[0]).not.toMatch(/ (?:and|or) /);
  });

  it.each(['docs/README.md.bak', 'docs/file.ts.old', 'docs/Makefile.am'])('does not link a prefix of a compound extension (%s)', (text) => {
    expect(findFilePathLinks(text)).toEqual([]);
  });

  it.each(['/a/a ', 'a/a '])('bounds failed scans across space-separated path segments (%s)', (prefix) => {
    const text = prefix.repeat(prefix === 'a/a ' ? 16_000 : 8_000) + 'z';
    const started = performance.now();
    expect(findFilePathLinks(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('skips spaced-path lookaheads for plain prose', () => {
    const text = 'a '.repeat(50_000) + 'z';
    const started = performance.now();
    expect(findFilePathLinks(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('isRelativeLinkCandidate', () => {
  it.each(['package.json', 'resources/kimi/kimi-logo-light.svg', './src/a.ts'])('accepts %s', (path) => {
    expect(isRelativeLinkCandidate(path)).toBe(true);
  });

  it.each(['../b/package.json', 'a/../b.ts', '/abs/x.ts', '~/x.ts', 'C:\\proj\\x.ts', '\\\\share\\x.ts'])('rejects %s', (path) => {
    expect(isRelativeLinkCandidate(path)).toBe(false);
  });
});

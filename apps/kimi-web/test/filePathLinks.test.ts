import { describe, expect, it } from 'vitest';
import { collectFilePathAliases, findFilePathLinks, parseFilePathLinkCandidate } from '../src/lib/filePathLinks';

describe('file path links', () => {
  it('parses relative paths with line numbers', () => {
    expect(parseFilePathLinkCandidate('apps/kimi-web/src/App.vue:23')).toEqual({
      path: 'apps/kimi-web/src/App.vue',
      line: 23,
    });
    expect(parseFilePathLinkCandidate('src/foo.ts#L9')).toEqual({
      path: 'src/foo.ts',
      line: 9,
    });
  });

  it('parses common root filenames', () => {
    expect(parseFilePathLinkCandidate('package.json')).toEqual({ path: 'package.json' });
    expect(parseFilePathLinkCandidate('AGENTS.md')).toEqual({ path: 'AGENTS.md' });
  });

  it('ignores bare asset filenames that are not reliable workspace paths', () => {
    expect(parseFilePathLinkCandidate('before.png')).toBeNull();
    expect(parseFilePathLinkCandidate('e2e-success.png')).toBeNull();
    expect(findFilePathLinks('Other images: before.png, e2e-success.png.')).toEqual([]);
  });

  it('uses same-message absolute path aliases for displayed asset filenames', () => {
    const aliases = collectFilePathAliases('<image path="/Users/moonshot/Downloads/before.png">');
    expect(findFilePathLinks('Displayed before.png.', { aliases })).toEqual([
      {
        path: '/Users/moonshot/Downloads/before.png',
        line: undefined,
        start: 10,
        end: 20,
        text: 'before.png',
      },
    ]);
  });

  it('ignores URLs and non-path words', () => {
    expect(parseFilePathLinkCandidate('https://example.com/a.ts')).toBeNull();
    expect(parseFilePathLinkCandidate('hello')).toBeNull();
  });

  it('ignores branch-like slash names without file extensions', () => {
    expect(parseFilePathLinkCandidate('feat/web')).toBeNull();
    expect(findFilePathLinks('commit db8d21cd on feat/web.')).toEqual([]);
  });

  it('finds multiple links in message text', () => {
    expect(findFilePathLinks('See apps/kimi-web/src/App.vue:11 and package.json.')).toEqual([
      {
        path: 'apps/kimi-web/src/App.vue',
        line: 11,
        start: 4,
        end: 32,
        text: 'apps/kimi-web/src/App.vue:11',
      },
      {
        path: 'package.json',
        line: undefined,
        start: 37,
        end: 49,
        text: 'package.json',
      },
    ]);
  });
});

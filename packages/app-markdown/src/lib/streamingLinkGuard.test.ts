import { describe, expect, it } from 'vitest';
import { streamingLinkAction } from './streamingLinkGuard';

describe('streamingLinkAction', () => {
  describe('in-page anchors', () => {
    it('passes through a plain anchor href', () => {
      expect(streamingLinkAction('#section', true)).toEqual({ type: 'passthrough' });
    });
  });

  describe('local workspace paths', () => {
    it('opens a file link through openFile when the host supports it', () => {
      expect(streamingLinkAction('src/foo.ts', true)).toEqual({
        type: 'open-file',
        path: 'src/foo.ts',
      });
    });

    it('swallows a file link when the host has no openFile', () => {
      expect(streamingLinkAction('src/foo.ts', false)).toEqual({ type: 'swallow' });
    });

    it('matches the settled pill action path: strip #/? tail, then decode', () => {
      expect(streamingLinkAction('./README.md#usage', true)).toEqual({
        type: 'open-file',
        path: './README.md',
        urlSuffix: '#usage',
      });
      expect(streamingLinkAction('docs/a%20b.ts', true)).toEqual({
        type: 'open-file',
        path: 'docs/a b.ts',
      });
    });

    it('keeps the query and fragment of a workspace-relative HTML link as the URL suffix', () => {
      expect(streamingLinkAction('site/index.html?tab=2#intro', true)).toEqual({
        type: 'open-file',
        path: 'site/index.html',
        urlSuffix: '?tab=2#intro',
      });
      expect(streamingLinkAction('site/index.html#78', true)).toEqual({
        type: 'open-file',
        path: 'site/index.html',
        urlSuffix: '#78',
      });
      expect(streamingLinkAction('site/index.html#L78', true)).toEqual({
        type: 'open-file',
        path: 'site/index.html',
        urlSuffix: '#L78',
      });
    });

    it.each([
      ['docs/情况.md:78', { type: 'open-file', path: 'docs/情况.md', line: 78 }],
      ['docs/foo\\(old\\).ts:78', { type: 'open-file', path: 'docs/foo(old).ts', line: 78 }],
      ['README.md:78', { type: 'open-file', path: 'README.md', line: 78 }],
      ['Makefile:10', { type: 'open-file', path: 'Makefile', line: 10 }],
      ['LICENSE:2', { type: 'open-file', path: 'LICENSE', line: 2 }],
      ['docs/情况.md#L78', { type: 'open-file', path: 'docs/情况.md', line: 78, urlSuffix: '#L78' }],
      ['C:/docs/a.ts:78', { type: 'open-file', path: 'C:/docs/a.ts', line: 78 }],
    ])('parses the line suffix in %s', (href, expected) => {
      expect(streamingLinkAction(href, true)).toEqual(expected);
    });

    it('classifies a Windows drive path as a file, not a scheme', () => {
      expect(streamingLinkAction('C:/docs/a.ts', true)).toEqual({
        type: 'open-file',
        path: 'C:/docs/a.ts',
      });
      expect(streamingLinkAction('C:%5Cdocs%5Ca.ts', true)).toEqual({
        type: 'open-file',
        path: 'C:\\docs\\a.ts',
      });
    });

    it('swallows folder links (inert even once settled)', () => {
      expect(streamingLinkAction('docs/', true)).toEqual({ type: 'swallow' });
    });

    it('swallows skill links (routed by the tooltip singleton once settled)', () => {
      expect(streamingLinkAction('kimi-code://skill/deploy', true)).toEqual({ type: 'swallow' });
    });
  });

  describe('external links', () => {
    it('opens http(s) links in a new window', () => {
      expect(streamingLinkAction('https://example.com/x', true)).toEqual({
        type: 'open-external',
        url: 'https://example.com/x',
      });
      expect(streamingLinkAction('http://example.com', false)).toEqual({
        type: 'open-external',
        url: 'http://example.com',
      });
    });
  });

  describe('everything else is swallowed', () => {
    it.each([
      ['mailto:a@b.com'],
      ['tel:+123'],
      ['vscode://file/x'],
      ['//host/path'],
      ['?page=2'],
      [''],
    ])('swallows %j', (href) => {
      expect(streamingLinkAction(href, true)).toEqual({ type: 'swallow' });
    });
  });
});

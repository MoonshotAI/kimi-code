import { describe, expect, it } from 'vitest';
import { streamingLinkAction } from './streamingLinkGuard';

// The streaming-link guard routes a RAW href (the link as markstream rendered
// it, before the settled pill rewrite) to one of four actions. Every branch
// must keep a streaming click away from a default navigation: relative
// workspace paths 404 on the server (no SPA fallback for extension paths) and
// replace the whole app mid-stream.
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
      });
      expect(streamingLinkAction('docs/a%20b.ts', true)).toEqual({
        type: 'open-file',
        path: 'docs/a b.ts',
      });
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

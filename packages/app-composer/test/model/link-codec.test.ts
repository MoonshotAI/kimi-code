import { describe, expect, it } from 'vitest';
import {
  decodeURIComponentOrRaw,
  encodeWireComponent,
  escapeLinkDest,
  escapeLinkText,
  unescapeLinkDest,
  unescapeLinkText,
  unescapeRenderedLinkText,
} from '../../src/model/linkCodec';

describe('composerLinkCodec', () => {
  it('keeps the canonical destination alphabet and non-ASCII readability', () => {
    expect(encodeWireComponent('a b/(稿).md')).toBe('a%20b%2F%28稿%29.md');
    expect(escapeLinkDest('docs/稿 件.md')).toBe('docs/稿%20件.md');
    expect(escapeLinkDest('//server/share')).toBe('/%2Fserver/share');
  });

  it('keeps a Windows drive-letter colon literal so models receive a usable path', () => {
    expect(escapeLinkDest('C:/docs/a.ts')).toBe('C:/docs/a.ts');
    expect(escapeLinkDest('C:\\docs\\a.ts')).toBe('C:%5Cdocs%5Ca.ts');
    expect(escapeLinkDest('C:/')).toBe('C:/');
    expect(escapeLinkDest('C:')).toBe('C%3A');
    expect(escapeLinkDest('docs/C:/a.ts')).toBe('docs/C%3A/a.ts');
  });

  it('round-trips raw link labels through both escaping layers', () => {
    const label = String.raw`a\[b]&<%0A` + '\n';
    const escaped = escapeLinkText(label);
    expect(unescapeLinkText(escaped)).toBe(label);

    expect(unescapeRenderedLinkText('a\\[b%26c')).toBe('a\\[b&c');
  });

  it('decodes canonical and historical destinations without throwing on malformed input', () => {
    expect(unescapeLinkDest('a%20b', false)).toBe('a b');
    expect(unescapeLinkDest('a\\(b\\)', false)).toBe('a(b)');
    expect(decodeURIComponentOrRaw('bad%')).toBe('bad%');
  });
});

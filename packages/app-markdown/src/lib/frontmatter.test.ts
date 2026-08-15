import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from './frontmatter';

describe('splitFrontmatter', () => {
  it('splits a basic frontmatter block', () => {
    const text = '---\nname: demo\ntags:\n  - a\n  - b\n---\n# Title\n\nBody text.\n';
    expect(splitFrontmatter(text)).toEqual({
      frontmatter: 'name: demo\ntags:\n  - a\n  - b\n',
      body: '# Title\n\nBody text.\n',
    });
  });

  it('handles CRLF line endings', () => {
    const text = '---\r\nname: demo\r\n---\r\n# Title\r\n';
    expect(splitFrontmatter(text)).toEqual({
      frontmatter: 'name: demo\r\n',
      body: '# Title\r\n',
    });
  });

  it('returns null for an empty frontmatter block', () => {
    const text = '---\n---\n# Title\n';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  it('returns null when the block is never closed', () => {
    const text = '---\nname: demo\nno closing fence\n';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  it('returns null when the opening fence is not at byte 0', () => {
    for (const text of [
      ' ---\nname: demo\n---\nbody\n',
      '\n---\nname: demo\n---\nbody\n',
      '\ufeff---\nname: demo\n---\nbody\n',
    ]) {
      expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
    }
  });

  it('returns null when --- appears later but not on the first line', () => {
    const text = '# Title\n\n---\nname: demo\n---\nbody\n';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  it('cuts the body at exactly the closing line, preserving what follows', () => {
    // A blank line right after the fence belongs to the body.
    const text = '---\nname: demo\n---\n\nbody\n';
    expect(splitFrontmatter(text)).toEqual({
      frontmatter: 'name: demo\n',
      body: '\nbody\n',
    });
  });

  it('accepts trailing whitespace on the closing fence', () => {
    const text = '---\nname: demo\n---  \nbody\n';
    expect(splitFrontmatter(text)).toEqual({
      frontmatter: 'name: demo\n',
      body: 'body\n',
    });
  });

  it('accepts trailing whitespace on the opening fence', () => {
    for (const text of [
      '--- \nname: demo\n---\nbody\n',
      '---\t\nname: demo\n---\nbody\n',
      '--- \r\nname: demo\r\n---\r\nbody\r\n',
    ]) {
      expect(splitFrontmatter(text)).toEqual({
        frontmatter: text.includes('\r') ? 'name: demo\r\n' : 'name: demo\n',
        body: text.includes('\r') ? 'body\r\n' : 'body\n',
      });
    }
  });

  it('returns null when a whitespace-suffixed opening fence is never closed', () => {
    for (const text of [
      '--- \nname: demo\nno closing fence\n',
      '---\t\nname: demo\n',
    ]) {
      expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
    }
  });

  it('does not treat a longer dash run or suffix as the opening fence', () => {
    for (const text of [
      '------\nname: demo\n---\nbody\n',
      '---x\nname: demo\n---\nbody\n',
      '---',
    ]) {
      expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
    }
  });

  it('does not treat a longer dash run as the closing fence', () => {
    const text = '---\nname: demo\n----\n---\nbody\n';
    expect(splitFrontmatter(text)).toEqual({
      frontmatter: 'name: demo\n----\n',
      body: 'body\n',
    });
  });

  it('handles a document that is only frontmatter', () => {
    expect(splitFrontmatter('---\nname: demo\n---')).toEqual({
      frontmatter: 'name: demo\n',
      body: '',
    });
    expect(splitFrontmatter('---\nname: demo\n---\n')).toEqual({
      frontmatter: 'name: demo\n',
      body: '',
    });
  });

  it('returns null for text without frontmatter', () => {
    const text = '# Just a title\n\nSome --- dashes --- inline.\n';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });
});

import { describe, expect, it } from 'vitest';
import { OutputStyleParseError, parseOutputStyle } from '../../src/output-style/parser';

describe('parseOutputStyle', () => {
  it('reads name + description from frontmatter and trims body', () => {
    const text = ['---', 'name: concise', 'description: Terse answers', '---', '', 'Be brief.', ''].join('\n');
    expect(parseOutputStyle(text, 'fallback')).toEqual({ name: 'concise', description: 'Terse answers', body: 'Be brief.' });
  });
  it('falls back to filename and first body line when frontmatter omits them', () => {
    const style = parseOutputStyle('Just instructions, no frontmatter.', 'my-style');
    expect(style.name).toBe('my-style');
    expect(style.description).toBe('Just instructions, no frontmatter.');
    expect(style.body).toBe('Just instructions, no frontmatter.');
  });
  it('throws when the body is empty', () => {
    expect(() => parseOutputStyle(['---', 'name: empty', '---', '', '   ', ''].join('\n'), 'empty')).toThrow(OutputStyleParseError);
  });
  it('throws OutputStyleParseError on invalid frontmatter YAML', () => {
    expect(() => parseOutputStyle(['---', 'name: "unterminated', '---', 'body'].join('\n'), 'x')).toThrow(OutputStyleParseError);
  });
});

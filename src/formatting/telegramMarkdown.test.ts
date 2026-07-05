import { describe, it, expect } from 'vitest';
import { convertToTelegramMarkdown } from './telegramMarkdown.js';

describe('convertToTelegramMarkdown', () => {
  it('returns plain text for an empty string', () => {
    const result = convertToTelegramMarkdown('');
    expect(result).toEqual({ text: '' });
  });

  it('escapes Telegram reserved characters in plain text', () => {
    const result = convertToTelegramMarkdown('hello_world (wow) ~test');
    expect(result).toEqual({
      text: 'hello\\_world \\(wow\\) \\~test',
      parseMode: 'MarkdownV2',
    });
  });

  it('preserves markdown backslash escapes as literal escaped characters', () => {
    const result = convertToTelegramMarkdown('\\*not bold\\*');
    expect(result).toEqual({
      text: '\\*not bold\\*',
      parseMode: 'MarkdownV2',
    });
  });

  it('converts bold markdown to Telegram bold', () => {
    const result = convertToTelegramMarkdown('**bold text**');
    expect(result).toEqual({ text: '*bold text*', parseMode: 'MarkdownV2' });
  });

  it('converts double-underscore bold markdown to Telegram bold', () => {
    const result = convertToTelegramMarkdown('__bold text__');
    expect(result).toEqual({ text: '*bold text*', parseMode: 'MarkdownV2' });
  });

  it('converts asterisk italic markdown to Telegram italic', () => {
    const result = convertToTelegramMarkdown('*italic text*');
    expect(result).toEqual({ text: '_italic text_', parseMode: 'MarkdownV2' });
  });

  it('converts underscore italic markdown to Telegram italic', () => {
    const result = convertToTelegramMarkdown('_italic text_');
    expect(result).toEqual({ text: '_italic text_', parseMode: 'MarkdownV2' });
  });

  it('does not treat word-internal underscores as italic', () => {
    const result = convertToTelegramMarkdown('snake_case_var');
    expect(result).toEqual({
      text: 'snake\\_case\\_var',
      parseMode: 'MarkdownV2',
    });
  });

  it('converts strikethrough markdown to Telegram strikethrough', () => {
    const result = convertToTelegramMarkdown('~~strikethrough~~');
    expect(result).toEqual({ text: '~strikethrough~', parseMode: 'MarkdownV2' });
  });

  it('converts inline code and escapes its interior', () => {
    const result = convertToTelegramMarkdown('`code with \\ backtick`');
    expect(result).toEqual({
      text: '`code with \\\\ backtick`',
      parseMode: 'MarkdownV2',
    });
  });

  it('converts fenced code blocks with language hint', () => {
    const result = convertToTelegramMarkdown('```typescript\nconst x = 1;\n```');
    expect(result).toEqual({
      text: '```typescript\nconst x = 1;\n```',
      parseMode: 'MarkdownV2',
    });
  });

  it('escapes backticks inside fenced code blocks', () => {
    const result = convertToTelegramMarkdown('```\nconst c = `x`;\n```');
    expect(result).toEqual({
      text: '```\nconst c = \\`x\\`;\n```',
      parseMode: 'MarkdownV2',
    });
  });

  it('escapes backslashes inside fenced code blocks', () => {
    const result = convertToTelegramMarkdown('```\nconst c = "a\\nb";\n```');
    expect(result).toEqual({
      text: '```\nconst c = "a\\\\nb";\n```',
      parseMode: 'MarkdownV2',
    });
  });

  it('does not treat indented triple backticks as a code-block fence', () => {
    const result = convertToTelegramMarkdown('```\n    const x = 1;\n```');
    expect(result).toEqual({
      text: '```\n    const x = 1;\n```',
      parseMode: 'MarkdownV2',
    });
  });

  it('converts headings to bold text', () => {
    expect(convertToTelegramMarkdown('# H1')).toEqual({
      text: '*H1*',
      parseMode: 'MarkdownV2',
    });
    expect(convertToTelegramMarkdown('## H2')).toEqual({
      text: '*H2*',
      parseMode: 'MarkdownV2',
    });
    expect(convertToTelegramMarkdown('### H3')).toEqual({
      text: '*H3*',
      parseMode: 'MarkdownV2',
    });
  });

  it('does not treat hashes without trailing whitespace as headings', () => {
    const result = convertToTelegramMarkdown('###not_a_heading');
    expect(result).toEqual({
      text: '\\#\\#\\#not\\_a\\_heading',
      parseMode: 'MarkdownV2',
    });
  });

  it('converts bullet lists by escaping markers', () => {
    const result = convertToTelegramMarkdown('- first\n* second\n+ third');
    expect(result).toEqual({
      text: '\\- first\n\\* second\n\\+ third',
      parseMode: 'MarkdownV2',
    });
  });

  it('converts numbered lists by escaping the dot', () => {
    const result = convertToTelegramMarkdown('1. first\n2. second');
    expect(result).toEqual({
      text: '1\\. first\n2\\. second',
      parseMode: 'MarkdownV2',
    });
  });

  it('converts markdown links to Telegram links', () => {
    const result = convertToTelegramMarkdown('[click here](https://example.com)');
    expect(result).toEqual({
      text: '[click here](https://example.com)',
      parseMode: 'MarkdownV2',
    });
  });

  it('escapes closing parentheses inside link URLs', () => {
    const result = convertToTelegramMarkdown('[a](https://example.com/path(b))');
    expect(result).toEqual({
      text: '[a](https://example.com/path(b\\))',
      parseMode: 'MarkdownV2',
    });
  });

  it('handles link labels and URLs with reserved characters', () => {
    const result = convertToTelegramMarkdown('[a_b](https://example.com/[section])');
    expect(result).toEqual({
      text: '[a\\_b](https://example.com/\\[section\\])',
      parseMode: 'MarkdownV2',
    });
  });

  it('escapes table pipe characters', () => {
    const result = convertToTelegramMarkdown('| a | b |');
    expect(result).toEqual({
      text: '\\| a \\| b \\|',
      parseMode: 'MarkdownV2',
    });
  });

  it('converts blockquotes by escaping the marker', () => {
    const result = convertToTelegramMarkdown('> quoted text');
    expect(result).toEqual({
      text: '\\> quoted text',
      parseMode: 'MarkdownV2',
    });
  });

  it('preserves unicode and emoji', () => {
    const result = convertToTelegramMarkdown('Привет 👋 **мир**');
    expect(result).toEqual({
      text: 'Привет 👋 *мир*',
      parseMode: 'MarkdownV2',
    });
  });

  it('does not allow nested formatting and escapes inner markers', () => {
    const result = convertToTelegramMarkdown('**bold _and_ italic**');
    expect(result).toEqual({
      text: '*bold \\_and\\_ italic*',
      parseMode: 'MarkdownV2',
    });
  });

  it('falls back to plain text for unclosed inline code', () => {
    const result = convertToTelegramMarkdown('`unclosed code');
    expect(result).toEqual({ text: '`unclosed code' });
  });

  it('falls back to plain text for unclosed code block', () => {
    const result = convertToTelegramMarkdown('```\nunclosed block');
    expect(result).toEqual({ text: '```\nunclosed block' });
  });

  it('falls back to plain text for unclosed bold markers', () => {
    const result = convertToTelegramMarkdown('**unclosed bold');
    expect(result).toEqual({ text: '**unclosed bold' });
  });

  it('falls back to plain text for unclosed double-underscore bold', () => {
    const result = convertToTelegramMarkdown('__unclosed bold');
    expect(result).toEqual({ text: '__unclosed bold' });
  });

  it('falls back to plain text for unclosed italic markers', () => {
    expect(convertToTelegramMarkdown('*unclosed italic')).toEqual({
      text: '*unclosed italic',
    });
    expect(convertToTelegramMarkdown('_unclosed italic')).toEqual({
      text: '_unclosed italic',
    });
  });

  it('falls back to plain text for unclosed strikethrough markers', () => {
    const result = convertToTelegramMarkdown('~~unclosed strike');
    expect(result).toEqual({ text: '~~unclosed strike' });
  });

  it('falls back to plain text for unclosed link markers', () => {
    const result = convertToTelegramMarkdown('[label](https://example.com');
    expect(result).toEqual({ text: '[label](https://example.com' });
  });

  it('strips images to a placeholder', () => {
    const result = convertToTelegramMarkdown('![alt text](https://example.com/img.png)');
    expect(result).toEqual({
      text: '📎 alt text',
      parseMode: 'MarkdownV2',
    });
  });

  it('falls back to truncated plain text when converted output exceeds Telegram message length', () => {
    const longInput = 'a'.repeat(5000);
    const result = convertToTelegramMarkdown(longInput);
    expect(result).toEqual({
      text: longInput.slice(0, 4093) + '...',
    });
  });

  it('truncates malformed fallback input that exceeds Telegram message length', () => {
    const longInput = '`' + 'a'.repeat(5000);
    const result = convertToTelegramMarkdown(longInput);
    expect(result.text.length).toBeLessThanOrEqual(4096);
    expect(result.text.endsWith('...')).toBe(true);
  });
});

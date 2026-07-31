import { resetCapabilitiesCache, setCapabilities } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import { linkifyTerminalUrls } from '#/tui/utils/linkify';

const ESC = '\u001B';
const BEL = '\u0007';

function stripAnsi(text: string): string {
  return text
    .replaceAll(/\u001B\]8;;[^\u0007]*\u0007/g, '')
    .replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('linkifyTerminalUrls', () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  it('returns the input unchanged when the terminal cannot render hyperlinks', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });

    const input = 'see https://example.com for details';
    expect(linkifyTerminalUrls(input)).toBe(input);
  });

  it('wraps a bare URL in a BEL-terminated OSC 8 hyperlink', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });

    const out = linkifyTerminalUrls('see https://example.com for details');

    expect(out).toContain(`${ESC}]8;;https://example.com${BEL}`);
    expect(out).toContain(`${ESC}]8;;${BEL}`);
    // Link text stays visible and surrounding prose is untouched.
    expect(stripAnsi(out)).toContain('see https://example.com for details');
  });

  it('linkifies multiple URLs in one string', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });

    const out = linkifyTerminalUrls('open https://a.example.com then https://b.example.com/x');

    expect(out).toContain(`${ESC}]8;;https://a.example.com${BEL}`);
    expect(out).toContain(`${ESC}]8;;https://b.example.com/x${BEL}`);
  });

  it('keeps sentence punctuation outside the link', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });

    const out = linkifyTerminalUrls('merged at https://example.com/pr/1.');

    expect(out).toContain(`${ESC}]8;;https://example.com/pr/1${BEL}`);
    expect(stripAnsi(out).endsWith('.')).toBe(true);
  });

  it('keeps a prose closing paren outside the link but preserves balanced parens', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });

    const prose = linkifyTerminalUrls('(see https://example.com)');
    expect(prose).toContain(`${ESC}]8;;https://example.com${BEL}`);
    expect(stripAnsi(prose)).toBe('(see https://example.com)');

    const balanced = linkifyTerminalUrls('https://example.com/wiki/Foo_(bar)');
    expect(balanced).toContain(`${ESC}]8;;https://example.com/wiki/Foo_(bar)${BEL}`);
  });

  it('applies the custom style to the linked text', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });

    const out = linkifyTerminalUrls('https://example.com', (s) => `<${s}>`);

    expect(out).toContain(`${ESC}]8;;https://example.com${BEL}<https://example.com>${ESC}]8;;${BEL}`);
  });
});

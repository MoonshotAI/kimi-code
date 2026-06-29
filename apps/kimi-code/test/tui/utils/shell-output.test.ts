import { describe, expect, it } from 'vitest';

import { formatBashOutputForDisplay, sanitizeShellOutput } from '#/tui/utils/shell-output';

const ESC = '\u001B';
const BEL = '\u0007';

function stripTheme(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('sanitizeShellOutput', () => {
  it('leaves plain text untouched', () => {
    expect(sanitizeShellOutput('hello\nworld')).toBe('hello\nworld');
  });

  it('strips SGR colour sequences', () => {
    expect(sanitizeShellOutput(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitizeShellOutput(`${ESC}[1;32mbold green${ESC}[0m`)).toBe('bold green');
  });

  it('strips CSI private modes (alt screen, cursor visibility)', () => {
    expect(sanitizeShellOutput(`${ESC}[?1049h${ESC}[?25l`)).toBe('');
    expect(sanitizeShellOutput(`before${ESC}[?2004hafter`)).toBe('beforeafter');
  });

  it('strips clear-screen and cursor-movement sequences', () => {
    expect(sanitizeShellOutput(`${ESC}[2J${ESC}[Hhello`)).toBe('hello');
    expect(sanitizeShellOutput(`${ESC}[10;5Hhi`)).toBe('hi');
  });

  it('strips OSC window titles', () => {
    expect(sanitizeShellOutput(`${ESC}]0;my title${BEL}text`)).toBe('text');
  });

  it('strips OSC 8 hyperlinks but keeps the link text', () => {
    const link = `${ESC}]8;;https://example.com${ESC}\\click here${ESC}]8;;${ESC}\\`;
    expect(sanitizeShellOutput(link)).toBe('click here');
  });

  it('strips carriage returns (spinner redraw)', () => {
    expect(sanitizeShellOutput('frame1\rframe2\rframe3')).toBe('frame1frame2frame3');
    expect(sanitizeShellOutput('line\r\nnext')).toBe('line\nnext');
  });

  it('strips backspace, bell and NUL', () => {
    expect(sanitizeShellOutput(`a\u0008b${BEL}c\u0000d`)).toBe('abcd');
  });

  it('preserves newlines and tabs', () => {
    expect(sanitizeShellOutput('a\nb\tc')).toBe('a\nb\tc');
  });

  it('strips single-char ESC commands (reset, save/restore cursor)', () => {
    expect(sanitizeShellOutput(`${ESC}c${ESC}7${ESC}8text`)).toBe('text');
  });

  it('never throws and returns "" for non-string input', () => {
    expect(sanitizeShellOutput(undefined as unknown as string)).toBe('');
    expect(sanitizeShellOutput(null as unknown as string)).toBe('');
    expect(sanitizeShellOutput(42 as unknown as string)).toBe('');
  });

  it('handles huge input without throwing', () => {
    const huge = `${ESC}[31m${'x'.repeat(2_000_000)}\r${ESC}[0m`;
    expect(() => sanitizeShellOutput(huge)).not.toThrow();
  });

  it('cleans a realistic TUI/dev-server burst down to printable text', () => {
    const messy =
      `${ESC}[?1049h${ESC}[?25l${ESC}[2J${ESC}[H` +
      `${ESC}[1m${ESC}[32mVITE${ESC}[0m ready in 120ms\r\n` +
      `${ESC}]0;dev server${BEL}` +
      `  Local: http://localhost:5173/`;
    const result = sanitizeShellOutput(messy);
    expect(result).not.toContain(ESC);
    expect(result).not.toContain('\r');
    expect(result).toContain('VITE ready in 120ms');
    expect(result).toContain('Local: http://localhost:5173/');
  });
});

describe('formatBashOutputForDisplay', () => {
  it('shows "(no output)" when both streams are empty', () => {
    expect(stripTheme(formatBashOutputForDisplay('', ''))).toBe('(no output)');
  });

  it('strips control sequences from stdout before rendering', () => {
    const result = stripTheme(formatBashOutputForDisplay(`${ESC}[?1049h${ESC}[31mhi${ESC}[0m\r`, ''));
    expect(result).not.toContain(ESC);
    expect(result).not.toContain('\r');
    expect(result).toContain('hi');
  });

  it('strips control sequences from stderr before rendering', () => {
    const result = stripTheme(formatBashOutputForDisplay('', `err${BEL}\r`, true));
    expect(result).not.toContain(ESC);
    expect(result).not.toContain(BEL);
    expect(result).not.toContain('\r');
    expect(result).toContain('err');
  });

  it('never throws on malformed / non-string input', () => {
    expect(() =>
      formatBashOutputForDisplay(undefined as unknown as string, null as unknown as string),
    ).not.toThrow();
  });
});

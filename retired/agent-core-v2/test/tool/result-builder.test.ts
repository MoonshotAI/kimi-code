import { describe, expect, it } from 'vitest';

import { ToolResultBuilder } from '#/tool/result-builder';

describe('ToolResultBuilder', () => {
  it('returns concatenated output and a confirmation message under the limit', () => {
    const builder = new ToolResultBuilder({ maxChars: 50 });

    expect(builder.write('Hello')).toBe(5);
    expect(builder.write(' world')).toBe(6);

    const result = builder.ok('Operation completed');
    expect(result.output).toBe('Hello world');
    expect(result.truncated).toBe(false);
    expect(builder.nChars).toBe(11);
  });

  it('truncates with marker at the cut point and appends the message after', () => {
    const builder = new ToolResultBuilder({ maxChars: 10 });

    expect(builder.write('Hello')).toBe(5);
    expect(builder.write(' world!')).toBe(14);
    expect(builder.nChars).toBeGreaterThanOrEqual(10);

    const result = builder.ok('Operation completed');
    expect(result.output).toContain('Hello[...truncated]');
    expect(result.output).toContain('Operation completed.');
    expect(result.output.endsWith('Output is truncated to fit in the message.')).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('truncates lines that exceed maxLineLength', () => {
    const builder = new ToolResultBuilder({ maxChars: 100, maxLineLength: 20 });

    expect(builder.write('This is a very long line that should be truncated\n')).toBe(20);

    const result = builder.ok();
    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Output is truncated');
  });

  it('respects both per-line and per-buffer limits at once', () => {
    const builder = new ToolResultBuilder({ maxChars: 40, maxLineLength: 20 });

    expect(builder.write('Line 1\n')).toBe(7);
    expect(builder.write('This is a very long line that exceeds limit\n')).toBe(20);
    expect(builder.write('This would exceed char limit')).toBe(14);
    expect(builder.write('ignored')).toBe(0);

    const result = builder.ok();
    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Output is truncated');
  });

  it('tracks nChars as the buffer grows', () => {
    const builder = new ToolResultBuilder({ maxChars: 20, maxLineLength: 30 });

    expect(builder.nChars).toBe(0);

    builder.write('Short\n');
    expect(builder.nChars).toBe(6);

    builder.write('1\n2\n');
    expect(builder.nChars).toBe(10);

    builder.write('More text that exceeds');
    expect(builder.nChars).toBeGreaterThanOrEqual(20);
  });

  it('marks truncation when non-empty text arrives after the buffer is full', () => {
    const builder = new ToolResultBuilder({ maxChars: 5 });

    expect(builder.write('Hello')).toBe(5);
    expect(builder.write(' world')).toBe(0);

    const result = builder.ok();
    expect(result.output).toContain('Hello[...truncated]');
    expect(result.output).toContain('Output is truncated');
    expect(result.truncated).toBe(true);
  });

  it('marks truncation when a multi-line write leaves unprocessed lines', () => {
    const builder = new ToolResultBuilder({ maxChars: 6 });

    expect(builder.write('Hello\nworld')).toBe(6);

    const result = builder.ok();
    expect(result.output).toContain('Hello\n[...truncated]');
    expect(result.output).toContain('Output is truncated');
  });

  it('keeps unterminated trailing text in output', () => {
    const builder = new ToolResultBuilder({ maxChars: 100 });

    expect(builder.write('Line 1\nLine 2\nLine 3')).toBe(20);

    const result = builder.ok();
    expect(result.output).toBe('Line 1\nLine 2\nLine 3');
  });

  it('treats an empty write as a no-op', () => {
    const builder = new ToolResultBuilder({ maxChars: 50 });

    expect(builder.write('')).toBe(0);
    expect(builder.nChars).toBe(0);
  });

  it('returns the accumulated output with the supplied error message', () => {
    const builder = new ToolResultBuilder({ maxChars: 20 });

    builder.write('Some output');
    const result = builder.error('Something went wrong');

    expect(result.output).toContain('Some output');
    expect(result.output).toContain('Something went wrong');
  });

  it('preserves the truncation hint on error', () => {
    const builder = new ToolResultBuilder({ maxChars: 10 });

    builder.write('Very long output that exceeds limit');
    const result = builder.error('Command failed');

    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Command failed');
    expect(result.output).toContain('Output is truncated');
  });

  it('returns executable output with critical messages included', () => {
    const builder = new ToolResultBuilder({ maxChars: 10 });

    builder.write('Very long output that exceeds limit');
    const result = builder.ok('Operation completed');

    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Operation completed.');
    expect(result.output).toContain('Output is truncated');
  });

  it('keeps normal success messages out of non-empty output', () => {
    const builder = new ToolResultBuilder({ maxChars: 100 });

    builder.write('ok\n');
    const result = builder.ok('Command executed successfully.');

    expect(result.output).toBe('ok\n');
  });

  it('truncates at exact maxChars boundary without losing the marker', () => {
    const builder = new ToolResultBuilder({ maxChars: 12 });

    builder.write('Hello World!!');
    expect(builder.nChars).toBeGreaterThanOrEqual(12);

    const result = builder.ok('Done');
    expect(result.output).toContain('[...truncated]');
    expect(result.truncated).toBe(true);
  });

  it('handles a single line that exactly fits maxLineLength', () => {
    const builder = new ToolResultBuilder({ maxChars: 100, maxLineLength: 20 });

    expect(builder.write('1234567890123456789\n')).toBe(20);
    const result = builder.ok();
    expect(result.output).toBe('1234567890123456789\n');
    expect(result.truncated).toBe(false);
  });

  it('handles a single line that exceeds maxLineLength by one character', () => {
    const builder = new ToolResultBuilder({ maxChars: 100, maxLineLength: 20 });

    expect(builder.write('123456789012345678901\n')).toBe(20);
    const result = builder.ok();
    expect(result.output).toContain('[...truncated]');
    expect(result.truncated).toBe(true);
  });

  it('returns empty output with error message when no content was written', () => {
    const builder = new ToolResultBuilder({ maxChars: 100 });

    const result = builder.error('Something went wrong');
    expect(result.output).toContain('Something went wrong');
    expect(result.truncated).toBe(false);
  });

  it('accumulates nChars correctly across multiple writes', () => {
    const builder = new ToolResultBuilder({ maxChars: 100 });

    builder.write('a');
    builder.write('b');
    builder.write('c');
    expect(builder.nChars).toBe(3);

    builder.write('def');
    expect(builder.nChars).toBe(6);
  });

  it('does not truncate when the buffer exactly matches maxChars', () => {
    const builder = new ToolResultBuilder({ maxChars: 10 });

    builder.write('1234567890');
    expect(builder.nChars).toBe(10);

    const result = builder.ok();
    expect(result.output).toBe('1234567890');
    expect(result.truncated).toBe(false);
  });

  it('truncates when the buffer just exceeds maxChars by one', () => {
    const builder = new ToolResultBuilder({ maxChars: 10 });

    builder.write('12345678901');
    expect(builder.nChars).toBeGreaterThanOrEqual(10);

    const result = builder.ok();
    expect(result.output).toContain('[...truncated]');
    expect(result.truncated).toBe(true);
  });

  it('preserves the error message in the truncated output', () => {
    const builder = new ToolResultBuilder({ maxChars: 10 });

    builder.write('Very long output');
    const result = builder.error('Failure!');

    expect(result.output).toContain('Failure!');
    expect(result.output).toContain('[...truncated]');
  });

  it('handles multiple writes that together cause truncation at maxLineLength', () => {
    const builder = new ToolResultBuilder({ maxChars: 100, maxLineLength: 20 });

    builder.write('12345678901234567\n');
    expect(builder.nChars).toBe(18);
    builder.write('12345678901234567890\n');
    // The second line exceeds maxLineLength 20, so it's truncated
    const result = builder.ok();
    expect(result.output).toContain('12345678901234567\n');
    expect(result.output).toContain('[...truncated]');
  });

  it('emits the truncation suffix exactly once even when both per-line and per-buffer limits are hit', () => {
    const builder = new ToolResultBuilder({ maxChars: 30, maxLineLength: 20 });

    builder.write('short line\n');
    builder.write('This is a very long line that exceeds max line length\n');
    builder.write('another short\n');

    const result = builder.ok();
    const truncatedCount = (result.output.match(/\[\.\.\.truncated\]/g) ?? []).length;
    expect(truncatedCount).toBe(1);
  });
});

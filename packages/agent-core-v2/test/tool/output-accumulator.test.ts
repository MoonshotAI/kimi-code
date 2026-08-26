import { describe, expect, it } from 'vitest';

import { ToolOutputAccumulator } from '#/tool/output-accumulator';

describe('ToolOutputAccumulator', () => {
  it('concatenates writes and tracks counters', () => {
    const builder = new ToolOutputAccumulator();

    builder.write('Hello');
    builder.write(' world');

    const result = builder.ok();
    expect(result.output).toBe('Hello world');
    expect(result.isError).toBe(false);
    expect(builder.nChars).toBe(11);
    expect(builder.totalChars).toBe(11);
    expect(result.spill).toBeUndefined();
  });

  it('uses the message as output when there is no output', () => {
    const builder = new ToolOutputAccumulator();

    const result = builder.ok('Operation completed');

    expect(result.output).toBe('Operation completed.');
  });

  it('appends a trailing period to an unpunctuated message', () => {
    const builder = new ToolOutputAccumulator();

    expect(builder.ok('Done').output).toBe('Done.');
    expect(builder.ok('Done.').output).toBe('Done.');
  });

  it('keeps normal success messages out of non-empty output', () => {
    const builder = new ToolOutputAccumulator();

    builder.write('ok\n');
    const result = builder.ok('Command executed successfully.');

    expect(result.output).toBe('ok\n');
  });

  it('carries the completion message in spill metadata for oversized output', () => {
    const builder = new ToolOutputAccumulator();

    builder.write('x'.repeat(50_001));
    const result = builder.ok('Command executed successfully.');

    expect(result.output).toBe('x'.repeat(50_001));
    expect(result.spill).toEqual({ suffix: 'Command executed successfully.' });
  });

  it('appends the error message after accumulated output', () => {
    const builder = new ToolOutputAccumulator();

    builder.write('Some output');
    const result = builder.error('Something went wrong');

    expect(result.output).toBe('Some output\nSomething went wrong');
    expect(result.isError).toBe(true);
  });

  it('does not insert a blank line when output ends with a newline', () => {
    const builder = new ToolOutputAccumulator();

    builder.write('out\n');
    const result = builder.error('Failed');

    expect(result.output).toBe('out\nFailed');
  });

  it('uses the error message as output when there is no output', () => {
    const builder = new ToolOutputAccumulator();

    expect(builder.error('Failed').output).toBe('Failed');
  });

  it('passes brief through on ok and error', () => {
    const okBuilder = new ToolOutputAccumulator();
    expect(okBuilder.ok('', { brief: 'b' }).brief).toBe('b');
    const errorBuilder = new ToolOutputAccumulator();
    expect(errorBuilder.error('e', { brief: 'b' }).brief).toBe('b');
  });

  it('caps retained output at 10MB and reports the true total via spill', () => {
    const builder = new ToolOutputAccumulator();

    builder.write('x'.repeat(10_000_000));
    builder.write('y'.repeat(5));

    const result = builder.ok();
    expect(result.output).toBe('x'.repeat(10_000_000));
    expect(builder.nChars).toBe(10_000_000);
    expect(builder.totalChars).toBe(10_000_005);
    expect(result.spill).toEqual({ totalChars: 10_000_005 });
  });

  it('attaches spill on error results as well when retention was capped', () => {
    const builder = new ToolOutputAccumulator();

    builder.write('x'.repeat(10_000_001));
    const result = builder.error('Command failed');

    expect(result.spill).toEqual({ totalChars: 10_000_001, suffix: 'Command failed' });
    expect(result.output).toContain('Command failed');
  });

  it('keeps the error message out of spill while everything fits in retention', () => {
    const builder = new ToolOutputAccumulator();

    builder.write('short');
    const result = builder.error('Command failed');

    expect(result.spill).toBeUndefined();
  });

  it('does not attach spill while everything fits in retention', () => {
    const builder = new ToolOutputAccumulator();

    builder.write('short');

    expect(builder.ok().spill).toBeUndefined();
  });

  it('treats an empty write as a no-op', () => {
    const builder = new ToolOutputAccumulator();

    builder.write('');

    expect(builder.nChars).toBe(0);
    expect(builder.totalChars).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';

import { TASK_OUTPUT_STREAM_MAX_CHARS, applyTaskOutputChunk } from '../src/lib/taskOutput';

describe('applyTaskOutputChunk', () => {
  it('appends a chunk that starts at the buffer end and tracks UTF-8 byte offsets', () => {
    const first = applyTaskOutputChunk(undefined, 4, 'héllo');
    expect(first).toEqual({ text: 'héllo', endOffset: 10 });
    expect(applyTaskOutputChunk(first, 10, ' 世界')).toEqual({ text: 'héllo 世界', endOffset: 17 });
  });

  it('replaces the buffer when a chunk does not continue it', () => {
    const buffer = applyTaskOutputChunk(undefined, 0, 'old');
    expect(applyTaskOutputChunk(buffer, 100, 'tail')).toEqual({ text: 'tail', endOffset: 104 });
  });

  it('keeps the newest lines when the buffer grows past the cap', () => {
    const line = `${'x'.repeat(99)}\n`;
    const text = line.repeat(Math.ceil(TASK_OUTPUT_STREAM_MAX_CHARS / line.length) + 10);
    const buffer = applyTaskOutputChunk(undefined, 0, text);
    expect(buffer.text.length).toBeLessThanOrEqual(TASK_OUTPUT_STREAM_MAX_CHARS);
    expect(buffer.text.startsWith('x')).toBe(true);
    expect(text.endsWith(buffer.text)).toBe(true);
    expect(buffer.endOffset).toBe(text.length);
  });

  it('does not start the capped buffer inside a surrogate pair', () => {
    const text = `a${'😀'.repeat(TASK_OUTPUT_STREAM_MAX_CHARS / 2)}b`;
    const buffer = applyTaskOutputChunk(undefined, 0, text);
    expect(buffer.text.length).toBe(TASK_OUTPUT_STREAM_MAX_CHARS - 1);
    expect(buffer.text.codePointAt(0)).toBe(0x1f600);
    expect(buffer.text.endsWith('😀b')).toBe(true);
  });
});

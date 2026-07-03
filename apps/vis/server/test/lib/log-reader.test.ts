import { describe, it, expect } from 'vitest';

import { parseLogLine } from '../../src/lib/log-reader';

describe('parseLogLine', () => {
  it('parses time, level, message, and trailing key=value fields', () => {
    const line = '2026-06-15T05:32:08.722Z INFO  llm config  turnStep=0.1 provider=openai model=coding-model-okapi thinkingEffort=high';
    const parsed = parseLogLine(line, 7);
    expect(parsed.lineNo).toBe(7);
    expect(parsed.time).toBe('2026-06-15T05:32:08.722Z');
    expect(parsed.level).toBe('INFO');
    expect(parsed.message).toBe('llm config');
    expect(parsed.fields).toEqual({
      turnStep: '0.1',
      provider: 'openai',
      model: 'coding-model-okapi',
      thinkingEffort: 'high',
    });
  });

  it('handles a message with no fields', () => {
    const parsed = parseLogLine('2026-06-15T05:32:16.680Z WARN  something happened', 1);
    expect(parsed.level).toBe('WARN');
    expect(parsed.message).toBe('something happened');
    expect(parsed.fields).toEqual({});
  });

  it('keeps unparseable lines verbatim as a message', () => {
    const parsed = parseLogLine('    at someStackFrame (file.ts:1:2)', 3);
    expect(parsed.time).toBeNull();
    expect(parsed.level).toBeNull();
    expect(parsed.message).toBe('    at someStackFrame (file.ts:1:2)');
    expect(parsed.raw).toBe('    at someStackFrame (file.ts:1:2)');
  });
});

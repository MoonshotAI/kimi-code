import { describe, expect, it } from 'vitest';
import { closeDanglingToolCalls } from '../../src/sessions/close-tool-calls.js';
import type { NormalizedMessage } from '../../src/sessions/translator.js';

function assistantWithCall(id: string): NormalizedMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [{ type: 'function', id, function: { name: 'Shell', arguments: '{}' } }],
  };
}

function toolResult(id: string): NormalizedMessage {
  return { role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'ok' }], toolCalls: [] };
}

function user(text: string): NormalizedMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

describe('closeDanglingToolCalls', () => {
  it('synthesizes a placeholder tool result for a dangling tool call', () => {
    const input: NormalizedMessage[] = [
      user('run echo hi'),
      assistantWithCall('tc1'),
      user('still here?'),
    ];
    const out = closeDanglingToolCalls(input);

    // assistant followed immediately by synthesized tool result, then user.
    expect(out).toHaveLength(4);
    expect(out[1]?.role).toBe('assistant');
    const synthesized = out[2];
    expect(synthesized?.role).toBe('tool');
    expect(synthesized?.toolCallId).toBe('tc1');
    expect(synthesized?.content[0]).toEqual({
      type: 'text',
      text: '[tool result unavailable — session imported from kimi-cli]',
    });
    // trailing user message survives.
    expect(out[3]).toEqual(user('still here?'));
  });

  it('leaves satisfied tool calls untouched', () => {
    const input: NormalizedMessage[] = [
      user('do it'),
      assistantWithCall('tc1'),
      toolResult('tc1'),
    ];
    const out = closeDanglingToolCalls(input);
    expect(out).toHaveLength(3);
    expect(out).toEqual(input);
  });

  it('inserts the synthesized result before any later real message', () => {
    const input: NormalizedMessage[] = [
      assistantWithCall('tc1'),
      assistantWithCall('tc2'),
    ];
    const out = closeDanglingToolCalls(input);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
    expect(out[1]?.toolCallId).toBe('tc1');
    expect(out[3]?.toolCallId).toBe('tc2');
  });
});

import type { Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { hasToolResultsSinceLastUserMessage } from '../../src/agent/turn/tool-stall-recovery';

describe('hasToolResultsSinceLastUserMessage', () => {
  it('returns false when the latest user message has no trailing tool results', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
    ];
    expect(hasToolResultsSinceLastUserMessage(messages)).toBe(false);
  });

  it('returns true when tool results follow the latest user message', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'explore' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'reading' }],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'Read', arguments: '{}' }],
      },
      { role: 'tool', content: [{ type: 'text', text: 'file contents' }], toolCalls: [], toolCallId: 'call_1' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will continue' }],
        toolCalls: [],
      },
    ];
    expect(hasToolResultsSinceLastUserMessage(messages)).toBe(true);
  });
});

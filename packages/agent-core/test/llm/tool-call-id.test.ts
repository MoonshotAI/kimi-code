import { describe, expect, it } from 'vitest';

import type { Message, StreamedMessagePart, ToolCall } from '#/llm/message';
import { uniqueToolCallIds } from '#/llm/protocol/rules/tool-call-ids';

function call(id: string, streamIndex?: number): ToolCall {
  return { type: 'function', id, name: 'Bash', arguments: '{}', _streamIndex: streamIndex };
}

function decodedIds(history: readonly Message[], parts: readonly StreamedMessagePart[]): string[] {
  const ids: string[] = [];
  const sink = uniqueToolCallIds(history, {
    onDelta: (part) => {
      if (part.type === 'function') ids.push(part.id);
    },
    onFinish: () => {},
  });
  for (const part of parts) sink.onDelta(part);
  return ids;
}

describe('uniqueToolCallIds', () => {
  it('keeps decoded ids unique against the history and within one response, preserving the raw id', () => {
    const history: Message[] = [
      { role: 'assistant', content: [], toolCalls: [call('Bash_0'), call('Bash_0__2')] },
      { role: 'tool', content: [], toolCallId: 'Bash_1' },
    ];
    const parts: StreamedMessagePart[] = [];
    const sink = uniqueToolCallIds(history, { onDelta: (part) => parts.push(part), onFinish: () => {} });
    sink.onDelta(call('Bash_0', 0));
    sink.onDelta(call('Bash_1', 1));
    expect(parts).toMatchObject([
      { id: 'Bash_0__3', rawId: 'Bash_0' },
      { id: 'Bash_1__2', rawId: 'Bash_1' },
    ]);

    expect(decodedIds([], [call('call_1', 0), call('call_2', 1)])).toEqual(['call_1', 'call_2']);
    expect(
      decodedIds(
        [],
        [call('Bash_0', 0), call('Bash_0', 1), call('Bash_0', 1), call('late_1'), call('late_1')],
      ),
    ).toEqual(['Bash_0', 'Bash_0__2', 'Bash_0__2', 'late_1', 'late_1__2']);
  });
});

import { describe, expect, it } from 'vitest';

import { createUserMessage, extractText, type ToolCall, type ToolMessage } from '@moonshot-ai/core/llm/message';
import { createMockProviderRequester, type MockProviderResponse } from '../../harness/scripted-generate';
import { createTestLoop as createLoop } from './core/factory';
import { executorFrom } from './core/executor';

function call(id: string, name = 'Bash'): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function requester(responses: MockProviderResponse[]) {
  return createMockProviderRequester(responses);
}

function done(text: string, toolCalls: ToolCall[] = []): MockProviderResponse {
  return { parts: [{ type: 'text', text }, ...toolCalls] };
}

function prompt() {
  return createUserMessage('work');
}

describe('handler tool execution', () => {
  it('executes duplicate calls independently and preserves model result order', async () => {
    let bashCalls = 0;
    const executor = executorFrom(['Bash', 'Read'], async ({ toolCall }) => {
      if (toolCall.name === 'Read') return { content: [{ type: 'text', text: 'read' }] };
      bashCalls += 1;
      return bashCalls === 2
        ? { content: [{ type: 'text', text: 'second failed' }], isError: true }
        : { content: [{ type: 'text', text: 'first ok' }] };
    });
    const scripted = requester([
      done('', [call('t1'), call('t1'), call('t2', 'Read')]),
      done('final'),
    ]);
    const loop = createLoop({
      requester: scripted,
      executor,
    });

    expect((await loop.runTurn(prompt())).type).toBe('done');
    const entries = loop.state.messages.filter((entry): entry is ToolMessage => entry.role === 'tool');
    expect(entries.map((entry) => extractText(entry))).toEqual(['first ok', 'second failed', 'read']);
    expect(entries.map((entry) => entry.attributes?.isError)).toEqual([undefined, true, undefined]);
    expect(bashCalls).toBe(2);
    await loop.close();
  });

  it('contains one tool failure without failing its sibling or the step', async () => {
    const executor = executorFrom(['Bash', 'Read'], async ({ toolCall }) => {
      if (toolCall.name === 'Bash') throw new Error('executor exploded');
      return { content: [{ type: 'text', text: 'read ok' }] };
    });
    const scripted = requester([done('', [call('t1'), call('t2', 'Read')]), done('final')]);
    const loop = createLoop({
      requester: scripted,
      executor,
    });

    expect((await loop.runTurn(prompt())).type).toBe('done');
    const entries = loop.state.messages.filter((entry): entry is ToolMessage => entry.role === 'tool');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.attributes?.isError).toBe(true);
    expect(entries[1]?.attributes?.isError).toBeUndefined();
    expect(extractText(entries[1]!)).toBe('read ok');
    await loop.close();
  });
});

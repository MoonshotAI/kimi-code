import { describe, expect, it } from 'vitest';

import { createUserEntry, type ToolEntry } from '#human/agent/turn';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '#human/llm/message';
import type { LlmRequest } from '#human/llm/request';
import type { LlmOutcome } from '#human/llm/response';
import type { LoopLlmRequester } from '#/agent/loop/core/index';
import { createTestLoop as createLoop } from './core/factory';
import { executorFrom } from './core/executor';

function call(id: string, name = 'Bash'): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function requester(outcomes: (() => LlmOutcome)[]): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async () => {
      const next = outcomes.shift();
      if (next === undefined) throw new Error('unexpected generate');
      return next();
    },
  };
  return self;
}

function done(text: string, toolCalls: ToolCall[] = []): () => LlmOutcome {
  return () => ({ type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) });
}

function prompt() {
  return createUserEntry(createUserMessage('work'));
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
      createTurnExecution: ({ profile }) => ({ profile, requester: scripted }),
      executor,
    });

    expect((await loop.runTurn(prompt())).type).toBe('done');
    const entries = loop.state.messages.filter((entry): entry is ToolEntry => entry.message.role === 'tool');
    expect(entries.map((entry) => extractText(entry.message))).toEqual(['first ok', 'second failed', 'read']);
    expect(entries.map((entry) => entry.meta?.isError)).toEqual([undefined, true, undefined]);
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
      createTurnExecution: ({ profile }) => ({ profile, requester: scripted }),
      executor,
    });

    expect((await loop.runTurn(prompt())).type).toBe('done');
    const entries = loop.state.messages.filter((entry): entry is ToolEntry => entry.message.role === 'tool');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.meta?.isError).toBe(true);
    expect(entries[1]?.meta?.isError).toBeUndefined();
    expect(extractText(entries[1]!.message)).toBe('read ok');
    await loop.close();
  });
});

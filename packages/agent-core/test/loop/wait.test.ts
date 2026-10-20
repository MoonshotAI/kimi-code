import { describe, expect, it } from 'vitest';

import { createHistoryMessageBuilder, createUserEntry } from '#/history/message';
import { createAssistantMessage } from '#/llm/message';
import type { LlmRequest } from '#/llm/request';
import type { LlmOutcome } from '#/llm/response';
import { createLoop, type LoopLlmRequester } from '#/loop/index';

function echoRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (): Promise<LlmOutcome> => ({
      type: 'done',
      message: createAssistantMessage([{ type: 'text', text: 'done' }]),
    }),
  };
  return self;
}

const prompt = (text: string) => createUserEntry(createHistoryMessageBuilder().plain(text).userMessage());

const noopExecutor = { execute: async () => ({ content: [] }) };

describe('loop.wait', () => {
  it('resolves with the first emitted event of the type passing match', async () => {
    const loop = createLoop({ requester: echoRequester, executor: noopExecutor });
    const pending = loop.wait('turn.ended', { match: (event) => event.turnId === 1 });
    await loop.runTurn(prompt('one'));
    await loop.runTurn(prompt('two'));
    const event = await pending;
    expect(event.turnId).toBe(1);
    expect(event.outcome.type).toBe('done');
    await loop.close();
  });

  it('does not resolve while match fails and rejects on timeout', async () => {
    const loop = createLoop({ requester: echoRequester, executor: noopExecutor });
    const missing = loop.wait('turn.ended', { match: (event) => event.turnId === 99, timeoutMs: 50 });
    await loop.runTurn(prompt('one'));
    await expect(missing).rejects.toThrow('wait timed out after 50ms');
    const timedOut = loop.wait('step.started', { timeoutMs: 20 });
    await expect(timedOut).rejects.toThrow('wait timed out after 20ms');
    await loop.close();
  });

  it('rejects when the external signal aborts', async () => {
    const loop = createLoop({ requester: echoRequester, executor: noopExecutor });
    const controller = new AbortController();
    const pending = loop.wait('turn.ended', { signal: controller.signal });
    controller.abort(new Error('stop-waiting'));
    await expect(pending).rejects.toThrow('stop-waiting');
    await loop.close();
  });
});

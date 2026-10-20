import { describe, expect, it } from 'vitest';

import { createUserEntry } from '#/history/message';
import { createAssistantMessage, createUserMessage, extractText } from '#/llm/message';
import type { LlmModelSpec, LlmRequest } from '#/llm/request';
import { mergeFields, type LlmRequestPart } from '#/llm/requester';
import type { LlmOutcome } from '#/llm/response';
import { createLoop, type LoopLlmRequester } from '#/loop/index';

const spec: LlmModelSpec = { provider: 'fake', name: 'fake-model' };

function fakeRequester(script: (request: LlmRequest) => LlmOutcome, filled: LlmRequestPart = {}): LoopLlmRequester {
  const complete = (part: LlmRequestPart) =>
    mergeFields(filled as Record<string, unknown>, part as Record<string, unknown>) as unknown as LlmRequest;
  return {
    with: (part) => fakeRequester(script, complete(part)),
    request: complete,
    generate: async (rest) => script(complete(rest)),
  };
}

function done(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

const noopExecutor = { execute: async () => ({ content: [] }) };

describe('loop.requester', () => {
  it('fills the host requester with the live history and delegates terminal calls to it', async () => {
    const seen: LlmRequest[] = [];
    const loop = createLoop({
      requester: () =>
        fakeRequester((request) => {
          seen.push(request);
          return done('reply');
        }).with({ model: { spec } }),
      executor: noopExecutor,
    });
    const empty = loop.requester.request({});
    expect(empty.model.spec).toEqual(spec);
    expect(empty.content.messages).toEqual([]);
    expect((await loop.runTurn(createUserEntry(createUserMessage('hello')))).type).toBe('done');
    seen.length = 0;
    const filled = loop.requester.request({});
    expect(filled.content.messages.map((message) => extractText(message))).toEqual(['hello', 'reply']);
    const outcome = await loop.requester
      .with({ profile: { systemPrompt: 'side' } })
      .generate({}, { signal: new AbortController().signal });
    expect(outcome.type).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.profile?.systemPrompt).toBe('side');
    expect(seen[0]?.content.messages.map((message) => extractText(message))).toEqual(['hello', 'reply']);
    expect(typeof seen[0]?.content.usedTokens).toBe('number');
    await loop.close();
  });

  it('re-reads the host requester getter on every call', async () => {
    let current = fakeRequester(() => done('a')).with({ model: { spec } });
    const loop = createLoop({ requester: () => current, executor: noopExecutor });
    expect(loop.requester.request({}).model.spec.name).toBe('fake-model');
    current = fakeRequester(() => done('b')).with({ model: { spec: { provider: 'fake', name: 'other-model' } } });
    expect(loop.requester.request({}).model.spec.name).toBe('other-model');
    await loop.close();
  });
});

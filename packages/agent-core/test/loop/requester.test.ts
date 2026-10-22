import { describe, expect, it } from 'vitest';

import { createUserEntry } from '#/history/message';
import { createAssistantMessage, createUserMessage, extractText } from '#/llm/message';
import type { LlmRecovery } from '#/llm/policy/recovery';
import type { MessageResolver } from '#/llm/policy/resolver';
import type { LlmRetryable } from '#/llm/policy/retry';
import type { LlmModelSpec, LlmRequest } from '#/llm/request';
import { contentsOf, createRequester, mergeFields, type LlmRequestPart } from '#/llm/requester';
import type { LlmOutcome } from '#/llm/response';
import { createLoop, type LoopLlmRequester } from '#/loop/index';

const spec: LlmModelSpec = { provider: 'fake', name: 'fake-model' };

function fakeRequester(script: (request: LlmRequest) => LlmOutcome, filled: LlmRequestPart = {}): LoopLlmRequester {
  const complete = (part: LlmRequestPart) =>
    mergeFields(filled as Record<string, unknown>, part as Record<string, unknown>) as unknown as LlmRequest;
  return {
    with: (part: LlmRequestPart | LoopLlmRequester) => fakeRequester(script, complete(contentsOf(part))),
    request: complete,
    generate: async (rest) => script(complete(rest)),
  };
}

function done(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

const noopExecutor = { execute: async () => ({ content: [] }) };

function listOf<T>(value: readonly T[] | (() => readonly T[]) | undefined): readonly T[] {
  return typeof value === 'function' ? value() : (value ?? []);
}

describe('loop.requester', () => {
  it('fills the host requester with the live history and delegates terminal calls to it', async () => {
    const seen: LlmRequest[] = [];
    const loop = createLoop({
      requester:
        fakeRequester((request) => {
          seen.push(request);
          return done('reply');
        }).with({ model: { spec } }),
      executor: noopExecutor,
    });
    const resolver: MessageResolver = { id: 'probe', resolve: async (messages) => messages };
    const recovery: LlmRecovery = { propose: () => undefined };
    const retryable: LlmRetryable = () => true;
    const removeResolver = loop.policy.addResolver(resolver);
    const removeRecovery = loop.policy.addRecovery(recovery);
    const removeRetryable = loop.policy.addRetryable(retryable);
    const empty = loop.requester.request({});
    expect(empty.model.spec).toEqual(spec);
    expect(empty.content.messages).toEqual([]);
    expect(listOf(empty.policy?.resolvers)).toEqual([resolver]);
    expect(listOf(empty.policy?.recoveries)).toEqual([recovery]);
    expect(listOf(empty.policy?.retryables)).toEqual([retryable]);
    expect((await loop.runTurn(createUserEntry(createUserMessage('hello')))).type).toBe('done');
    expect(listOf(seen[0]?.policy?.resolvers)).toEqual([resolver]);
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
    removeResolver();
    removeRecovery();
    removeRetryable();
    expect(loop.policy.resolvers).toEqual([]);
    expect(listOf(loop.requester.request({}).policy?.resolvers)).toEqual([]);
    await loop.close();
  });

  it('setRequester swaps the base requester, and with(requester) merges its contents', async () => {
    const first = fakeRequester(() => done('a')).with({ model: { spec } });
    const loop = createLoop({ executor: noopExecutor });
    expect(loop.baseRequester).toBeUndefined();
    expect(() => loop.requester.request({})).toThrow('loop has no requester');
    loop.setRequester(first);
    expect(loop.baseRequester).toBe(first);
    expect(loop.requester.request({}).model.spec.name).toBe('fake-model');
    const second = fakeRequester(() => done('b')).with({
      model: { spec: { provider: 'fake', name: 'other-model' } },
    });
    loop.setRequester(second);
    expect(loop.baseRequester).toBe(second);
    expect(loop.requester.request({}).model.spec.name).toBe('other-model');
    loop.setRequester(undefined);
    expect(loop.baseRequester).toBeUndefined();

    const other: LlmModelSpec = { provider: 'fake', name: 'other-model' };
    const source = createRequester().with({ model: { spec } }).with({ content: { messages: [], usedTokens: 5 } });
    const merged: LoopLlmRequester = createRequester()
      .with({ model: { spec: other, sampling: { temperature: 1 } } })
      .with(source);
    const request = merged.request({});
    expect(request.model?.spec).toEqual(spec);
    expect(request.model?.sampling).toEqual({ temperature: 1 });
    expect(request.content).toEqual({ messages: [], usedTokens: 5 });
    const overridden: LoopLlmRequester = merged.with({ model: { spec: other } });
    expect(overridden.request({}).model).toEqual({ spec: other, sampling: { temperature: 1 } });
    expect(() => createRequester().with(first)).toThrow('requester does not expose its contents');
    const fromFacade: LoopLlmRequester = createRequester().with(
      loop.requester.with({ profile: { systemPrompt: 'side' } }),
    );
    expect(fromFacade.request({}).profile?.systemPrompt).toBe('side');
    expect(fromFacade.request({}).content?.messages).toBeUndefined();
    await loop.close();
  });
});

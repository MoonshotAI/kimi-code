import { describe, expect, it } from 'vitest';

import { createUserEntry } from '#human/agent/turn';
import { createAssistantMessage, createUserMessage, extractText } from '#human/llm/message';
import type { LlmRecovery } from '#human/llm/policy/recovery';
import type { LlmResolver } from '#human/llm/policy/resolver';
import type { LlmRetryable } from '#human/llm/policy/retry';
import type { LlmModelSpec, LlmRequest } from '#human/llm/request';
import { contentsOf, createRequester, mergeFields, type LlmRequestPart } from '#human/llm/requester';
import type { LlmOutcome } from '#human/llm/response';
import type { LoopLlmRequester, LoopProfile } from '#/agent/loop/core/index';
import { createTestLoop as createLoop } from './factory';
import { executorFrom, successfulExecutor } from './executor';

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

const noopExecutor = successfulExecutor(['work']);

function listOf<T>(value: readonly T[] | (() => readonly T[]) | undefined): readonly T[] {
  return typeof value === 'function' ? value() : (value ?? []);
}

describe('loop.requester', () => {
  it('creates one execution per turn and fills live history and policies', async () => {
    const seen: LlmRequest[] = [];
    const profiles: LoopProfile[] = [];
    const tools = [{ name: 'baseline', description: 'baseline tool', parameters: { type: 'object', properties: {} } }];
    const loop = createLoop({
      createTurnExecution: ({ profile }) => {
        profiles.push(profile);
        return {
          profile,
          requester: fakeRequester((request) => {
            seen.push(request);
            return done('reply');
          }).with({ model: { spec } }),
        };
      },
      executor: noopExecutor,
      input: { profile: { tools } },
    });
    expect('setTools' in loop).toBe(false);
    const resolver: LlmResolver = { id: 'probe', resolve: async (request) => request };
    const recovery: LlmRecovery = { propose: () => undefined };
    const retryable: LlmRetryable = () => true;
    const removeResolver = loop.policy.addResolver(resolver);
    const removeRecovery = loop.policy.addRecovery(recovery);
    const removeRetryable = loop.policy.addRetryable(retryable);
    expect(loop.turnExecution).toBeUndefined();
    expect((await loop.runTurn(createUserEntry(createUserMessage('hello')))).type).toBe('done');
    expect(profiles).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model.spec).toEqual(spec);
    expect(seen[0]?.profile?.tools).toEqual(tools);
    expect(seen[0]?.content.messages.map((message) => extractText(message))).toEqual(['hello']);
    expect(listOf(seen[0]?.policy?.resolvers)).toEqual([resolver]);
    expect(listOf(seen[0]?.policy?.recoveries)).toEqual([recovery]);
    expect(listOf(seen[0]?.policy?.retryables)).toEqual([retryable]);
    expect(typeof seen[0]?.content.usedTokens).toBe('number');
    removeResolver();
    removeRecovery();
    removeRetryable();
    expect(loop.policy.resolvers).toEqual([]);

    expect((await loop.runTurn(createUserEntry(createUserMessage('again')))).type).toBe('done');
    expect(profiles).toHaveLength(2);
    expect(seen[1]?.content.messages.map((message) => extractText(message))).toEqual(['hello', 'reply', 'again']);
    expect(listOf(seen[1]?.policy?.resolvers)).toEqual([]);
    expect(loop.turnExecution).toBeUndefined();
    expect('setTools' in loop).toBe(false);
    expect(loop.state.profile.tools).toEqual(tools);
    await loop.close();
  });

  it('setRequester changes only the next turn factory, and with(requester) merges contents', async () => {
    const seen: LlmRequest[] = [];
    const models: string[] = [];
    const first = fakeRequester((request) => {
      seen.push(request);
      models.push('first');
      if (seen.length === 1) {
        return {
          type: 'done',
          message: createAssistantMessage(
            [{ type: 'text', text: 'a' }],
            [{ type: 'function', id: 'call-work', name: 'work', arguments: '{}' }],
          ),
        };
      }
      return done('a');
    }).with({ model: { spec } });
    const second = fakeRequester((request) => {
      seen.push(request);
      models.push('second');
      return done('b');
    }).with({
      model: { spec: { provider: 'fake', name: 'other-model' } },
    });
    const loop = createLoop({
      executor: executorFrom(['work'], async () => {
        loop.setRequester(second);
        return { content: [] };
      }),
    });
    loop.setRequester(first);
    expect((await loop.runTurn(createUserEntry(createUserMessage('first')))).type).toBe('done');
    expect(models).toEqual(['first', 'first']);
    expect(seen[1]?.content.messages.length).toBeGreaterThan(seen[0]!.content.messages.length);
    expect((await loop.runTurn(createUserEntry(createUserMessage('second')))).type).toBe('done');
    expect(models).toEqual(['first', 'first', 'second']);
    loop.setRequester(undefined);
    expect((await loop.runTurn(createUserEntry(createUserMessage('third')))).type).toBe('failed');

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
      source.with({ profile: { systemPrompt: 'side' } }),
    );
    expect(fromFacade.request({}).profile?.systemPrompt).toBe('side');
    expect(fromFacade.request({}).content?.messages).toEqual([]);
    await loop.close();
  });
});

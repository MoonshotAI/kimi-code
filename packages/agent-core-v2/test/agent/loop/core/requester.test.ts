import { describe, expect, it } from 'vitest';

import { createUserMessage, extractText } from '@moonshot-ai/core/llm/message';
import type { LlmRecovery } from '@moonshot-ai/core/llm/policy/recovery';
import type { LlmResolver } from '@moonshot-ai/core/llm/policy/resolver';
import type { LlmRetryable } from '@moonshot-ai/core/llm/policy/retry';
import type { LlmModelSpec, LlmRequest } from '@moonshot-ai/core/llm/request';
import { createRequester, type InitializedLlmRequester, type LlmDimension, type LlmRequester, type LlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { LoopEmitted } from '@moonshot-ai/core/loop/index';
import { createMockProviderRequester, providerHttpError, type MockProviderResponse } from '../../../harness/scripted-generate';
import { createTestLoop as createLoop } from './factory';
import { executorFrom, successfulExecutor } from './executor';

const spec: LlmModelSpec = { provider: 'fake', name: 'fake-model' };

function fakeRequester(script: (request: LlmRequest) => MockProviderResponse, filled: LlmRequestPart = {}): InitializedLlmRequester {
  return createMockProviderRequester(script).with(filled as never);
}

function done(text: string): MockProviderResponse {
  return { parts: [{ type: 'text', text }] };
}

const noopExecutor = successfulExecutor(['work']);

function listOf<T>(value: readonly T[] | (() => readonly T[]) | undefined): readonly T[] {
  return typeof value === 'function' ? value() : (value ?? []);
}

describe('loop.requester', () => {
  it('fills live history and policies on the turn requester', async () => {
    const seen: LlmRequest[] = [];
    const tools = [{ name: 'baseline', description: 'baseline tool', parameters: { type: 'object', properties: {} } }];
    const requester = fakeRequester((request) => {
      seen.push(request);
      return done('reply');
    }).with({ model: { spec } });
    const loop = createLoop({
      requester,
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
    expect((await loop.runTurn(createUserMessage('hello'))).type).toBe('done');
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

    expect((await loop.runTurn(createUserMessage('again'))).type).toBe('done');
    expect(seen[1]?.content.messages.map((message) => extractText(message))).toEqual(['hello', 'reply', 'again']);
    expect(listOf(seen[1]?.policy?.resolvers)).toEqual([]);
    expect('setTools' in loop).toBe(false);
    expect(loop.state.profile.tools).toEqual(tools);
    await loop.close();
  });

  it('setRequester changes only the next turn requester, and with(requester) merges contents', async () => {
    const seen: LlmRequest[] = [];
    const models: string[] = [];
    const first = fakeRequester((request) => {
      seen.push(request);
      models.push('first');
      if (seen.length === 1) {
        return {
          parts: [
            { type: 'text', text: 'a' },
            { type: 'function', id: 'call-work', name: 'work', arguments: '{}' },
          ],
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
    expect((await loop.runTurn(createUserMessage('first'))).type).toBe('done');
    expect(models).toEqual(['first', 'first']);
    expect(seen[1]?.content.messages.length).toBeGreaterThan(seen[0]!.content.messages.length);
    expect((await loop.runTurn(createUserMessage('second'))).type).toBe('done');
    expect(models).toEqual(['first', 'first', 'second']);
    loop.setRequester(undefined);
    expect((await loop.runTurn(createUserMessage('third'))).type).toBe('failed');

    const other: LlmModelSpec = { provider: 'fake', name: 'other-model' };
    const source = createRequester().with({ model: { spec } }).with({ content: { messages: [], usedTokens: 5 } });
    const merged: LlmRequester<LlmDimension> = createRequester()
      .with({ model: { spec: other, sampling: { temperature: 1 } } })
      .with(source);
    const request = merged.request({});
    expect(request.model?.spec).toEqual(spec);
    expect(request.model?.sampling).toEqual({ temperature: 1 });
    expect(request.content).toEqual({ messages: [], usedTokens: 5 });
    const overridden: LlmRequester<LlmDimension> = merged.with({ model: { spec: other } });
    expect(overridden.request({}).model).toEqual({ spec: other, sampling: { temperature: 1 } });
    const fromInitialized = createRequester().with(first);
    expect(fromInitialized.request({ content: { messages: [], usedTokens: 0 } }).model.spec).toEqual(spec);
    const fromFacade: LlmRequester<LlmDimension> = createRequester().with(
      source.with({ profile: { systemPrompt: 'side' } }),
    );
    expect(fromFacade.request({}).profile?.systemPrompt).toBe('side');
    expect(fromFacade.request({}).content?.messages).toEqual([]);
    await loop.close();
  });

  it('stamps turn and step on llm retries and streamed tool argument deltas', async () => {
    const scripted = createMockProviderRequester([
      providerHttpError(429, 'rate limited', { retryAfterMs: 1 }),
      {
        parts: [
          { type: 'function', id: 'call-work', name: 'work', arguments: '{"path":', _streamIndex: 0 },
          { type: 'tool_call_part', index: 0, argumentsPart: '"a.ts"}' },
        ],
      },
      done('finished'),
    ]).with({ policy: { retry: { maxAttemptsPerStep: 2 } } });
    const loop = createLoop({ requester: scripted, executor: noopExecutor });
    const events: LoopEmitted[] = [];
    loop.subscribe((event) => events.push(event));

    expect((await loop.runTurn(createUserMessage('run work'))).type).toBe('done');

    expect(events.filter((event) => event.type === 'llm.retry')).toMatchObject([
      { turnId: 0, step: 1, reason: 'backoff', failedAttempt: 1, nextAttempt: 2, maxAttempts: 2 },
    ]);
    const deltas = events.filter((event) => event.type === 'llm.delta.part');
    const stepOneDeltas = deltas.filter((event) => event.step === 1);
    expect(stepOneDeltas.length).toBeGreaterThanOrEqual(2);
    expect(stepOneDeltas.every((event) => event.turnId === 0)).toBe(true);
    expect(stepOneDeltas.some((event) => event.part.type === 'function')).toBe(true);
    expect(stepOneDeltas.some((event) => event.part.type === 'tool_call_part')).toBe(true);
    expect(deltas.filter((event) => event.step !== 1).map((event) => [event.turnId, event.step, event.part.type])).toEqual([
      [0, 2, 'text'],
    ]);
    expect(events.filter((event) => event.type === 'llm.requested').map((event) => [event.turnId, event.step])).toEqual([
      [0, 1],
      [0, 1],
      [0, 2],
    ]);
    expect(events.filter((event) => event.type === 'llm.ended').map((event) => [event.turnId, event.step, event.outcome.type])).toEqual([
      [0, 1, 'done'],
      [0, 2, 'done'],
    ]);
    expect(events.filter((event) => event.type === 'tool.ended')).toMatchObject([
      { turnId: 0, step: 1, toolCallId: 'call-work', outcome: { type: 'succeeded' } },
    ]);
    await loop.close();
  });
});

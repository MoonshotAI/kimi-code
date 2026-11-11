import { describe, expect, it } from 'vitest';

import { createUserEntry } from '@moonshot-ai/core/llm/history';
import { createUserMessage, extractText } from '@moonshot-ai/core/llm/message';
import type { LlmRecovery } from '@moonshot-ai/core/llm/policy/recovery';
import type { LlmResolver } from '@moonshot-ai/core/llm/policy/resolver';
import type { LlmRetryable } from '@moonshot-ai/core/llm/policy/retry';
import type { LlmModelSpec, LlmProtocolRequest } from '@moonshot-ai/core/llm/request';
import { createRequester, type InitializedLlmRequester, type LlmDimension, type LlmRequester, type LlmRequestPart } from '@moonshot-ai/core/llm/requester';
import { createMockProviderRequester, type MockProviderResponse } from '../../../harness/scripted-generate';
import { createTestLoop as createLoop } from './factory';
import { executorFrom, successfulExecutor } from './executor';

const spec: LlmModelSpec = { provider: 'fake', name: 'fake-model' };

function fakeRequester(script: (request: LlmProtocolRequest) => MockProviderResponse, filled: LlmRequestPart = {}): InitializedLlmRequester {
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
  it('creates one requester snapshot per turn and fills live history and policies', async () => {
    const seen: LlmProtocolRequest[] = [];
    let snapshotCount = 0;
    const tools = [{ name: 'baseline', description: 'baseline tool', parameters: { type: 'object', properties: {} } }];
    const requester = fakeRequester((request) => {
      seen.push(request);
      return done('reply');
    }).with({ model: { spec } });
    const loop = createLoop({
      requester: {
        ...requester,
        snapshot: () => {
          snapshotCount += 1;
          return requester;
        },
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
    expect((await loop.runTurn(createUserEntry(createUserMessage('hello')))).type).toBe('done');
    expect(snapshotCount).toBe(1);
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
    expect(snapshotCount).toBe(2);
    expect(seen[1]?.content.messages.map((message) => extractText(message))).toEqual(['hello', 'reply', 'again']);
    expect(listOf(seen[1]?.policy?.resolvers)).toEqual([]);
    expect('setTools' in loop).toBe(false);
    expect(loop.state.profile.tools).toEqual(tools);
    await loop.close();
  });

  it('setRequester changes only the next turn requester, and with(requester) merges contents', async () => {
    const seen: LlmProtocolRequest[] = [];
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
    expect((await loop.runTurn(createUserEntry(createUserMessage('first')))).type).toBe('done');
    expect(models).toEqual(['first', 'first']);
    expect(seen[1]?.content.messages.length).toBeGreaterThan(seen[0]!.content.messages.length);
    expect((await loop.runTurn(createUserEntry(createUserMessage('second')))).type).toBe('done');
    expect(models).toEqual(['first', 'first', 'second']);
    loop.setRequester(undefined);
    expect((await loop.runTurn(createUserEntry(createUserMessage('third')))).type).toBe('failed');

    const other: LlmModelSpec = { provider: 'fake', name: 'other-model' };
    const source = createRequester().with({ model: { spec } }).with({ content: { entries: [], usedTokens: 5 } });
    const merged: LlmRequester<LlmDimension> = createRequester()
      .with({ model: { spec: other, sampling: { temperature: 1 } } })
      .with(source);
    const request = merged.request({});
    expect(request.model?.spec).toEqual(spec);
    expect(request.model?.sampling).toEqual({ temperature: 1 });
    expect(request.content).toEqual({ entries: [], usedTokens: 5 });
    const overridden: LlmRequester<LlmDimension> = merged.with({ model: { spec: other } });
    expect(overridden.request({}).model).toEqual({ spec: other, sampling: { temperature: 1 } });
    const fromInitialized = createRequester().with(first);
    expect(fromInitialized.request({ content: { entries: [], usedTokens: 0 } }).model.spec).toEqual(spec);
    const fromFacade: LlmRequester<LlmDimension> = createRequester().with(
      source.with({ profile: { systemPrompt: 'side' } }),
    );
    expect(fromFacade.request({}).profile?.systemPrompt).toBe('side');
    expect(fromFacade.request({}).content?.entries).toEqual([]);
    await loop.close();
  });
});

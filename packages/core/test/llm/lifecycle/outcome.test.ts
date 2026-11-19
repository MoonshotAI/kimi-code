// Historical coverage: issue #149, #520, #1952, #3149 and #4012; PR #3101 and #4977.
import { describe, expect, it } from 'vitest';

import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { createAssistantMessage } from '#/llm/message';
import { emptyResponseError } from '#/llm/policy/settle';
import type { LlmModelSpec } from '#/llm/request';
import { NO_FINISH } from '#/llm/response';
import { setClock } from '#/utils/clock';

import {
  accumulatedMessage,
  aimockEndpoint,
  failedOutcome,
  openAIChunk,
  rawMockResponse,
  runGenerate,
  testModule,
  useAimockServer,
} from '../harness';

describe('LLM final outcomes', () => {
  const server = useAimockServer();

  it('as a user, I want empty and thinking-only responses to be distinguished from visible output', () => {
    const model: LlmModelSpec = { provider: 'test', name: 'test-model' };
    const empty = accumulatedMessage([]);
    expect(emptyResponseError(empty, model, NO_FINISH)).toMatchObject({
      kind: 'empty_response',
      finishReason: null,
      rawFinishReason: null,
      retryable: true,
    });
    expect(emptyResponseError(empty, model, {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    })).toMatchObject({ kind: 'empty_response', retryable: false });
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'think', think: 'reasoning' }]), model, NO_FINISH)
        ?.message,
    ).toContain('only thinking content');
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'text', text: '  \n' }]), model, NO_FINISH),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: ' ' },
        ]),
        model,
        NO_FINISH,
      )?.message,
    ).toContain('only thinking content');
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'text', text: 'hi' }]), model, NO_FINISH),
    ).toBeNull();
    expect(
      emptyResponseError(
        createAssistantMessage([], [{ type: 'function', id: 'call_1', name: 'tool', arguments: '{}' }]),
        model,
        NO_FINISH,
      ),
    ).toBeNull();
  });

  it('as a user, I want repeated provider output to fail with an empty-response error', async () => {
    const model: LlmModelSpec = { provider: 'test', name: 'test-model' };
    const finish = { finishReason: 'other', rawFinishReason: 'repeat' } as const;
    for (const message of [
      accumulatedMessage([{ type: 'text', text: 'repeated text' }]),
      accumulatedMessage([{ type: 'function', id: 'call_1', name: 'tool', arguments: '{}' }]),
    ]) {
      expect(emptyResponseError(message, model, finish)).toMatchObject({
        kind: 'empty_response',
        rawFinishReason: 'repeat',
        retryable: true,
        message: expect.stringContaining('repeated output'),
      });
    }

    server().llm.on({ predicate: () => true }, rawMockResponse('openai-chat', {
      sse: { events: [openAIChunk({ content: 'repeated text' }, { finishReason: 'repeat' })] },
    }));
    const repeated = failedOutcome((await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
    })).outcome);
    expect(repeated.error).toMatchObject({
      kind: 'empty_response',
      rawFinishReason: 'repeat',
      retryable: true,
      message: expect.stringContaining('repeated output'),
    });
  });

  it('as a user, I want invalid thinking configuration and HTTP failures to be classified, and aborted streams to preserve partial output', async () => {
    const syntax = failedOutcome((await runGenerate(openAIProtocol, {
      module: testModule({
        model: {
          spec: { provider: 'test', name: 'test-model', capability: { thinking: false } },
          thinking: { effort: 'high' },
        },
      }),
      endpoint: aimockEndpoint(server().url),
    })).outcome);
    expect(syntax.error).toMatchObject({ kind: 'syntax', code: 'thinking_config' });

    server().llm.on({ predicate: () => true }, rawMockResponse('openai-chat', {
      status: 500,
      json: { error: { message: 'provider unavailable', type: 'server_error' } },
    }));
    const provider = failedOutcome((await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
    })).outcome);
    expect(provider.error).toMatchObject({
      kind: 'status',
      message: 'provider unavailable',
      statusCode: 500,
      retryable: true,
    });

    server().llm.clearFixtures();
    server().llm.on(
      { predicate: () => true },
      rawMockResponse('openai-chat', {
        sse: {
          events: [
            openAIChunk({ content: 'partial' }),
            openAIChunk({}, { finishReason: 'stop' }),
          ],
        },
      }),
      { streamingProfile: { ttft: 0, tps: 10 } },
    );
    const controller = new AbortController();
    const aborted = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'llm.delta.part') controller.abort();
      },
    });
    expect(aborted.outcome).toMatchObject({
      type: 'aborted',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        toolCalls: [],
        attributes: { source: 'salvaged' },
      },
      reason: { kind: 'abort' },
    });
    expect(aborted.events.at(-1)).toMatchObject({
      type: 'llm.ended',
      outcome: { type: 'aborted' },
    });
  });

  it('as a user, I want turning thinking off to use the model declared off effort', async () => {
    server().llm.on({ predicate: () => true }, rawMockResponse('openai-chat', {
      sse: { events: [openAIChunk({ content: 'ok' }, { finishReason: 'stop' })] },
    }));

    const result = await runGenerate(openAIProtocol, {
      module: testModule({
        model: {
          spec: {
            provider: 'openai',
            name: 'test-model',
            capability: { thinking: true },
            thinking: { offEffort: 'none' },
          },
          thinking: { effort: 'off' },
        },
      }),
      endpoint: aimockEndpoint(server().url),
    });

    expect(result.outcome.type).toBe('done');
    expect(server().llm.getRequests()[0]?.body).toMatchObject({ reasoning_effort: 'none' });
  });

  it('as a user, I want always-thinking models to reject disabling thinking before any provider request', async () => {
    const result = await runGenerate(openAIProtocol, {
      module: testModule({
        model: {
          spec: {
            provider: 'openai',
            name: 'test-model',
            capability: { thinking: true },
            thinking: { alwaysThinking: true, supportEfforts: ['low', 'high'] },
          },
          thinking: { effort: 'off' },
        },
      }),
      endpoint: aimockEndpoint(server().url),
    });

    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: { kind: 'syntax', code: 'thinking_config' },
    });
    expect(result.events.map((event) => event.type)).toEqual(['llm.started', 'llm.requested', 'llm.ended']);
    expect(server().llm.getRequests()).toHaveLength(0);
  });

  it('as an API consumer, I want unexpected internal failures to become a final failed outcome instead of an unhandled rejection', async () => {
    setClock(() => {
      throw new Error('clock failed');
    });
    let result;
    try {
      result = await runGenerate(googleGenAIProtocol, {
        module: testModule(),
        endpoint: aimockEndpoint(server().url),
      });
    } finally {
      setClock();
    }

    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: { kind: 'unknown', message: 'clock failed' },
    });
    expect(result.events.map((event) => event.type)).toEqual([
      'llm.started',
      'llm.requested',
      'llm.ended',
    ]);
    expect(server().llm.getRequests()).toHaveLength(0);
  });
});

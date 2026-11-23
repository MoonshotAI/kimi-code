// Historical coverage: PR #2, #101, #1349, #1448 and #5017.
import { describe, expect, it } from 'vitest';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { llmErrorName, llmErrorRequestId } from '#/llm/response';

import {
  aimockEndpoint,
  doneOutcome,
  openAIChunk,
  rawMockResponse,
  runGenerate,
  testModule,
  useAimockServer,
} from '../harness';

describe('LLM response metadata', () => {
  const server = useAimockServer();

  it('as an API consumer, I want response headers, provider ids, usage and timing preserved in the final outcome', async () => {
    const finish = { finishReason: 'completed', rawFinishReason: 'stop' } as const;
    const usage = {
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
    };
    server().llm.on({ predicate: () => true }, rawMockResponse('openai-chat', {
      headers: { 'x-request-id': 'req-success' },
      sse: {
        events: [
          openAIChunk({ content: 'hello' }, { id: 'msg-1' }),
          openAIChunk({}, { finishReason: 'stop', usage }),
        ],
      },
    }));
    const result = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
    });
    const done = doneOutcome(result.outcome);

    expect(result.events[2]).toMatchObject({
      type: 'llm.delta.response_header',
      headers: { 'x-request-id': 'req-success' },
    });
    expect(result.events[3]).toMatchObject({ type: 'llm.delta.request_id', requestId: 'req-success' });
    expect(result.events[4]).toMatchObject({ type: 'llm.delta.message_id', messageId: 'msg-1' });
    expect(result.events[6]).toMatchObject({
      type: 'llm.delta.usage',
      usage: {
        inputOther: 8,
        output: 2,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        raw: usage,
      },
    });
    expect(result.events[7]).toMatchObject({ type: 'llm.delta.finish', finish });
    expect(result.events[8]).toMatchObject({
      type: 'llm.delta.timing',
      firstTokenLatencyMs: expect.any(Number),
      streamDurationMs: expect.any(Number),
    });
    expect(done).toMatchObject({
      requestId: 'req-success',
      usage: { inputOther: 8, output: 2 },
      message: { attributes: { messageId: 'msg-1', finish } },
    });
  });

  it('as an SDK consumer, I want stable error names for display and telemetry', () => {
    const status = {
      message: 'failure',
      statusCode: 500,
      requestId: null,
      retryAfterMs: null,
      headers: null,
      retryable: true,
    };
    expect(llmErrorName({ kind: 'abort', message: 'failure', retryable: false })).toBe('AbortError');
    expect(llmErrorName({ kind: 'connection', message: 'failure', retryable: true })).toBe('APIConnectionError');
    expect(llmErrorName({ kind: 'timeout', message: 'failure', retryable: true })).toBe('APITimeoutError');
    expect(llmErrorName({
      kind: 'empty_response',
      message: 'failure',
      finishReason: null,
      rawFinishReason: null,
      retryable: true,
    })).toBe('APIEmptyResponseError');
    expect(llmErrorName({ kind: 'context_overflow', ...status })).toBe('APIContextOverflowError');
    expect(llmErrorName({ kind: 'rate_limit', ...status })).toBe('APIProviderRateLimitError');
    expect(llmErrorName({ kind: 'quota_exhausted', ...status })).toBe('APIProviderQuotaExhaustedError');
    expect(llmErrorName({ kind: 'overloaded', ...status })).toBe('APIProviderOverloadedError');
    expect(llmErrorName({ kind: 'status', ...status })).toBe('APIStatusError');
    expect(llmErrorName({ kind: 'auth', ...status })).toBe('APIStatusError');
    expect(llmErrorName({ kind: 'provider', message: 'failure', retryable: false })).toBe('ChatProviderError');
    expect(llmErrorName({ kind: 'provider', message: 'failure', retryable: false, name: 'CustomError' })).toBe('CustomError');
  });

  it('as a support user, I want error request ids to fall back to trace ids when necessary', () => {
    const status = {
      message: 'failure',
      statusCode: 500,
      requestId: null,
      retryAfterMs: null,
      headers: null,
      retryable: true,
    };
    expect(llmErrorRequestId({ kind: 'provider', message: 'failure', retryable: false })).toBeUndefined();
    expect(llmErrorRequestId({
      kind: 'status',
      ...status,
      requestId: 'req-1',
      headers: { 'x-trace-id': 'trace-1' },
    })).toBe('req-1');
    expect(llmErrorRequestId({
      kind: 'status',
      ...status,
      headers: { 'X-Trace-Id': 'trace-1' },
    })).toBe('trace-1');
    expect(llmErrorRequestId({
      kind: 'status',
      ...status,
      headers: { 'x-trace-id': '' },
    })).toBeUndefined();
    expect(llmErrorRequestId({ kind: 'status', ...status })).toBeUndefined();
  });
});

// Historical coverage: issue #451 and #4334; PR #92, #201, #3624, #3734 and #4574.
import { describe, expect, it } from 'vitest';

import { createMediaDegradeRecovery } from '#/llm/builtin/policy/media-degrade';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import type { LlmRecovery } from '#/llm/policy/recovery';

import {
  aimockEndpoint,
  doneOutcome,
  openAIChunk,
  rawMockResponse,
  runGenerate,
  testModule,
  useAimockServer,
} from '../harness';

describe('LLM retry boundaries', () => {
  const server = useAimockServer();

  it('as a user, I want a backoff retry to start a fresh requested delta segment', async () => {
    const replies = [
      rawMockResponse('openai-chat', {
        status: 429,
        headers: { 'x-request-id': 'req-failed', 'retry-after': '0.001' },
        json: { error: { message: 'retry', type: 'rate_limit_error' } },
      }),
      rawMockResponse('openai-chat', {
        headers: { 'x-request-id': 'req-success' },
        sse: {
          events: [openAIChunk(
            { content: 'ok' },
            { finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } },
          )],
        },
      }),
    ];
    let sends = 0;
    server().llm.on(
      { predicate: () => true },
      () => replies[Math.min(sends++, replies.length - 1)]!,
    );

    const result = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      policy: { retry: { maxAttemptsPerStep: 2 } },
    });
    expect(doneOutcome(result.outcome).message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.events.map((event) => event.type)).toEqual([
      'llm.started',
      'llm.requested',
      'llm.retry',
      'llm.requested',
      'llm.delta.response_header',
      'llm.delta.request_id',
      'llm.delta.usage',
      'llm.delta.part',
      'llm.delta.finish',
      'llm.delta.timing',
      'llm.ended',
    ]);
    expect(result.events.filter((event) => event.type === 'llm.requested')).toMatchObject([
      { attempt: '1' },
      { attempt: '2' },
    ]);
    const retry = result.events.findIndex((event) => event.type === 'llm.retry');
    expect(result.events[retry]).toMatchObject({
      reason: 'backoff',
      failedAttempt: 1,
      nextAttempt: 2,
      delayMs: expect.any(Number),
    });
    expect(result.events.slice(0, retry).some((event) => event.type.startsWith('llm.delta.'))).toBe(false);
    expect(server().llm.getRequests()).toHaveLength(2);
  });

  it('as a user, I want recovery to rewrite the next real request and start a fresh delta segment', async () => {
    const recovery: LlmRecovery = {
      propose: ({ appliedRecoveries }) => appliedRecoveries.length > 0
        ? undefined
        : {
            strategy: 'test-recovery',
            action: 'rewrite',
            rewrite: (request) => ({
              ...request,
              model: { ...request.model, cacheKey: 'recovered' },
            }),
          },
    };
    const replies = [
      rawMockResponse('openai-chat', {
        headers: { 'x-request-id': 'req-failed' },
        sse: { events: [openAIChunk({ content: 'partial' })] },
      }),
      rawMockResponse('openai-chat', {
        headers: { 'x-request-id': 'req-success' },
        sse: { events: [openAIChunk({ content: 'ok' }, { finishReason: 'stop' })] },
      }),
    ];
    let sends = 0;
    server().llm.on(
      { predicate: () => true },
      () => replies[Math.min(sends++, replies.length - 1)]!,
    );

    const result = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      policy: { retry: { maxAttemptsPerStep: 1 }, recoveries: [recovery] },
    });
    expect(doneOutcome(result.outcome).message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.events.map((event) => event.type)).toEqual([
      'llm.started',
      'llm.requested',
      'llm.delta.response_header',
      'llm.delta.request_id',
      'llm.delta.part',
      'llm.delta.timing',
      'llm.retry',
      'llm.requested',
      'llm.delta.response_header',
      'llm.delta.request_id',
      'llm.delta.part',
      'llm.delta.finish',
      'llm.delta.timing',
      'llm.ended',
    ]);
    expect(result.events.filter((event) => event.type === 'llm.requested')).toHaveLength(2);
    const retry = result.events.findIndex((event) => event.type === 'llm.retry');
    expect(result.events[retry]).toMatchObject({
      reason: 'recovery',
      strategy: 'test-recovery',
      action: 'rewrite',
      message: { content: [{ type: 'text', text: 'partial' }] },
    });
    expect(result.events.slice(0, retry).some((event) => event.type === 'llm.delta.finish')).toBe(false);
    const requests = server().llm.getRequests();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toMatchObject({ prompt_cache_key: 'recovered' });
  });

  it('as a user, I want aborting backoff to prevent another provider request', async () => {
    const controller = new AbortController();
    server().llm.on({ predicate: () => true }, rawMockResponse('openai-chat', {
      status: 429,
      headers: { 'retry-after': '60' },
      json: { error: { message: 'retry later', type: 'rate_limit_error' } },
    }));

    const result = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      signal: controller.signal,
      policy: { retry: { maxAttemptsPerStep: 2 } },
      onEvent: (event) => {
        if (event.type === 'llm.retry') controller.abort('stop backoff');
      },
    });

    expect(result.outcome).toMatchObject({ type: 'aborted', reason: 'stop backoff' });
    expect(result.events.map((event) => event.type)).toEqual([
      'llm.started',
      'llm.requested',
      'llm.retry',
      'llm.ended',
    ]);
    expect(result.events.filter((event) => event.type === 'llm.requested')).toHaveLength(1);
    expect(server().llm.getRequests()).toHaveLength(1);
  });

  it('as a user, I want a disconnected stream to retry without repeating partial content', async () => {
    let sends = 0;
    server().llm.on(
      { predicate: () => sends === 0 },
      () => {
        sends += 1;
        return rawMockResponse('openai-chat', {
          headers: { 'x-request-id': 'req-disconnected' },
          sse: {
            events: [
              openAIChunk({ content: 'partial' }),
              openAIChunk({}, { finishReason: 'stop' }),
            ],
          },
        });
      },
      { truncateAfterChunks: 2, streamingProfile: { ttft: 0, tps: 10 } },
    );
    server().llm.on(
      { predicate: () => sends === 1 },
      rawMockResponse('openai-chat', {
        headers: { 'x-request-id': 'req-success' },
        sse: { events: [openAIChunk({ content: 'ok' }, { finishReason: 'stop' })] },
      }),
    );

    const result = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      policy: { retry: { maxAttemptsPerStep: 2 } },
    });

    expect(doneOutcome(result.outcome).message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.events.filter((event) => event.type === 'llm.requested')).toHaveLength(2);
    const retryIndex = result.events.findIndex((event) => event.type === 'llm.retry');
    expect(result.events[retryIndex]).toMatchObject({ reason: 'backoff' });
    expect(result.events.slice(0, retryIndex).some((event) => event.type === 'llm.delta.finish')).toBe(false);
    expect(result.events.some((event) => event.type === 'llm.delta.part' && event.part.type === 'text' && event.part.text === 'partial')).toBe(true);
    expect(server().llm.getRequests()).toHaveLength(2);
  });

  it('as a user, I want oversized media requests to recover with a compatible rewritten request', async () => {
    const replies = [
      rawMockResponse('openai-chat', {
        status: 413,
        json: { error: { message: 'request too large', type: 'invalid_request_error' } },
      }),
      rawMockResponse('openai-chat', {
        headers: { 'x-request-id': 'req-success' },
        sse: { events: [openAIChunk({ content: 'recovered' }, { finishReason: 'stop' })] },
      }),
    ];
    let sends = 0;
    server().llm.on(
      { predicate: () => true },
      () => replies[Math.min(sends++, replies.length - 1)]!,
    );

    const result = await runGenerate(openAIProtocol, {
      module: testModule({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this image' },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
          ],
        }],
      }),
      endpoint: aimockEndpoint(server().url),
      policy: {
        retry: { maxAttemptsPerStep: 1 },
        recoveries: [createMediaDegradeRecovery()],
      },
    });

    expect(doneOutcome(result.outcome).message.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(result.events.find((event) => event.type === 'llm.retry')).toMatchObject({
      reason: 'recovery',
      strategy: 'media-degrade',
      action: 'stripped',
    });
    const requests = server().llm.getRequests();
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.body)).toContain('data:image/png;base64,AAAA');
    const recoveredBody = JSON.stringify(requests[1]?.body);
    expect(recoveredBody).not.toContain('data:image/png;base64,AAAA');
    expect(recoveredBody).toContain('[image omitted for provider compatibility');
  });

  it('as a user, I want oversized requests to drop only older media and send the degraded placeholder text', async () => {
    const replies = [
      rawMockResponse('openai-chat', {
        status: 413,
        json: { error: { message: 'request too large', type: 'invalid_request_error' } },
      }),
      rawMockResponse('openai-chat', {
        headers: { 'x-request-id': 'req-success' },
        sse: { events: [openAIChunk({ content: 'recovered' }, { finishReason: 'stop' })] },
      }),
    ];
    let sends = 0;
    server().llm.on(
      { predicate: () => true },
      () => replies[Math.min(sends++, replies.length - 1)]!,
    );

    const result = await runGenerate(openAIProtocol, {
      module: testModule({
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,OLDER' } },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,RECENT1' } },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,RECENT2' } },
          ],
        }],
      }),
      endpoint: aimockEndpoint(server().url),
      policy: {
        retry: { maxAttemptsPerStep: 1 },
        recoveries: [createMediaDegradeRecovery()],
      },
    });

    expect(doneOutcome(result.outcome).message.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(result.events.find((event) => event.type === 'llm.retry')).toMatchObject({
      reason: 'recovery',
      strategy: 'media-degrade',
      action: 'degraded',
    });
    const requests = server().llm.getRequests();
    expect(requests).toHaveLength(2);
    const recoveredBody = JSON.stringify(requests[1]?.body);
    expect(recoveredBody).not.toContain('data:image/png;base64,OLDER');
    expect(recoveredBody).toContain('data:image/png;base64,RECENT1');
    expect(recoveredBody).toContain('data:image/png;base64,RECENT2');
    expect(recoveredBody).toContain(
      '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
    );
    expect(recoveredBody).not.toContain('omitted":');
  });
});

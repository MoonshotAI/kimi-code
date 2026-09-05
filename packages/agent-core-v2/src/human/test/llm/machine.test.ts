import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActor } from '#/xstate2';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import type { LlmErrorMessage } from '#/llm/errors';
import type { ContentPart, Message } from '#/llm/message';
import { createMediaDegradeRecovery } from '#/llm/media/degrade';
import type { LlmModel } from '#/llm/model';
import { createLlmMachine, type LlmEvent } from '#/llm/requester/machine';
import type { LlmRequester } from '#/llm/requester/requester';
import type { LlmRetryOptions } from '#/llm/requester/retry';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type RetryingEvent = Extract<LlmEvent, { type: 'llm.retrying' }>;

function statusError(
  statusCode: number,
  message: string,
  retryAfterMs: number | null = null,
): LlmErrorMessage {
  return { kind: 'status', statusCode, message, requestId: null, retryAfterMs, headers: null };
}

function createStubRequester(
  plan: readonly (LlmErrorMessage | 'ok' | 'empty' | 'think_only' | 'filtered_empty')[],
) {
  let calls = 0;
  const requester: LlmRequester = {
    generate: (_config, _content, { onEvent }) => {
      const step = plan[Math.min(calls, plan.length - 1)];
      calls += 1;
      if (step === 'ok') {
        onEvent?.({ type: 'llm.delta', part: { type: 'text', text: 'done' } });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      }
      if (step === 'empty') {
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      }
      if (step === 'think_only') {
        onEvent?.({ type: 'llm.delta', part: { type: 'think', think: 'reasoning' } });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      }
      if (step === 'filtered_empty') {
        onEvent?.({
          type: 'llm.finish',
          finish: { finishReason: 'filtered', rawFinishReason: 'content_filter' },
        });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      }
      if (step.kind === 'syntax') {
        onEvent?.({ type: 'llm.failed.syntax', error: step });
        return Promise.resolve();
      }
      onEvent?.({ type: 'llm.failed.remote', error: step });
      return Promise.resolve();
    },
  };
  return { requester, calls: () => calls };
}

function startRetryingActor(requester: LlmRequester, retry?: LlmRetryOptions) {
  const actor = createActor(createLlmMachine({ requester, retry }), {
    input: { config: { model }, content: { messages: [] as readonly Message[] } },
  });
  const retrying: RetryingEvent[] = [];
  const failed: unknown[] = [];
  actor.on('llm.retrying', (event) => retrying.push(event));
  actor.on('llm.failed.syntax', (event) => failed.push(event.error));
  actor.on('llm.failed.remote', (event) => failed.push(event.error));
  actor.start();
  return { actor, retrying, failed };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('llm machine retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries retryable errors and succeeds', async () => {
    const { requester, calls } = createStubRequester([
      'empty',
      'think_only',
      statusError(429, 'rate limited'),
      statusError(500, 'server error'),
      { kind: 'provider', message: 'Error: upstream error, status_code=429: too many requests' },
      'ok',
    ]);
    const { actor, retrying, failed } = startRetryingActor(requester, {
      maxAttemptsPerStep: 6,
    });

    await flush();
    expect(retrying).toHaveLength(1);
    expect(retrying[0]).toMatchObject({
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 6,
      errorName: 'empty_response',
    });
    expect(retrying[0]?.errorMessage).toContain('empty response (no content, no tool calls)');
    expect(retrying[0]?.errorMessage).toContain('Provider: test, model: test-model');

    await vi.advanceTimersByTimeAsync((retrying[0] as RetryingEvent).delayMs + 1);
    await flush();
    expect(retrying).toHaveLength(2);
    expect(retrying[1]).toMatchObject({
      failedAttempt: 2,
      nextAttempt: 3,
      maxAttempts: 6,
      errorName: 'empty_response',
    });
    expect(retrying[1]?.errorMessage).toContain('only thinking content');

    await vi.advanceTimersByTimeAsync((retrying[1] as RetryingEvent).delayMs + 1);
    await flush();
    expect(retrying).toHaveLength(3);
    expect(retrying[2]).toMatchObject({
      failedAttempt: 3,
      nextAttempt: 4,
      maxAttempts: 6,
      statusCode: 429,
      errorName: 'status',
    });

    await vi.advanceTimersByTimeAsync((retrying[2] as RetryingEvent).delayMs + 1);
    await flush();
    expect(retrying).toHaveLength(4);
    expect(retrying[3]).toMatchObject({
      failedAttempt: 4,
      nextAttempt: 5,
      maxAttempts: 6,
      statusCode: 500,
    });

    await vi.advanceTimersByTimeAsync((retrying[3] as RetryingEvent).delayMs + 1);
    await flush();
    expect(retrying).toHaveLength(5);
    expect(retrying[4]).toMatchObject({
      failedAttempt: 5,
      nextAttempt: 6,
      maxAttempts: 6,
      errorName: 'provider',
    });

    await vi.advanceTimersByTimeAsync((retrying[4] as RetryingEvent).delayMs + 1);
    await flush();
    expect(actor.getSnapshot().value).toBe('succeeded');
    expect(calls()).toBe(6);
    expect(failed).toHaveLength(0);
  });

  it('fails after maxAttemptsPerStep is exhausted', async () => {
    const { requester, calls } = createStubRequester([
      statusError(503, 'unavailable'),
      statusError(503, 'unavailable'),
      statusError(503, 'unavailable'),
    ]);
    const { actor, retrying, failed } = startRetryingActor(requester, {
      maxAttemptsPerStep: 3,
    });

    await flush();
    await vi.advanceTimersByTimeAsync((retrying[0] as RetryingEvent).delayMs + 1);
    await flush();
    await vi.advanceTimersByTimeAsync((retrying[1] as RetryingEvent).delayMs + 1);
    await flush();

    expect(retrying).toHaveLength(2);
    expect(calls()).toBe(3);
    expect(actor.getSnapshot().value).toBe('failed');
    expect(failed).toHaveLength(1);
  });

  it('does not retry non-retryable errors', async () => {
    const cases: readonly LlmErrorMessage[] = [
      {
        kind: 'syntax',
        code: 'request_format',
        message: 'Tool call arguments must be valid JSON.',
      },
      {
        kind: 'request_structure',
        statusCode: 400,
        message: 'roles must alternate',
        requestId: null,
        retryAfterMs: null,
        headers: null,
      },
    ];
    for (const error of cases) {
      const { requester, calls } = createStubRequester([error, 'ok']);
      const { actor, retrying, failed } = startRetryingActor(requester, {
        maxAttemptsPerStep: 5,
      });

      await flush();

      expect(retrying).toHaveLength(0);
      expect(calls()).toBe(1);
      expect(actor.getSnapshot().value).toBe('failed');
      expect(failed).toHaveLength(1);
    }

    const filtered = createStubRequester(['filtered_empty', 'ok']);
    const filteredRun = startRetryingActor(filtered.requester, { maxAttemptsPerStep: 5 });

    await flush();

    expect(filteredRun.retrying).toHaveLength(0);
    expect(filtered.calls()).toBe(1);
    expect(filteredRun.actor.getSnapshot().value).toBe('failed');
    expect(filteredRun.failed[0]).toMatchObject({
      kind: 'empty_response',
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
  });

  it('retries a non-retryable error when infiniteRetry is on', async () => {
    const { requester, calls } = createStubRequester([statusError(400, 'bad request'), 'ok']);
    const { actor, retrying } = startRetryingActor(requester, { infiniteRetry: true });

    await flush();
    expect(retrying).toHaveLength(1);
    expect(retrying[0]).toMatchObject({ failedAttempt: 1, nextAttempt: 2, maxAttempts: 10 });

    await vi.advanceTimersByTimeAsync((retrying[0] as RetryingEvent).delayMs + 1);
    await flush();
    expect(actor.getSnapshot().value).toBe('succeeded');
    expect(calls()).toBe(2);
  });

  it('prefers retryAfterMs from the error over the backoff delay', async () => {
    const cases: readonly [LlmErrorMessage, number][] = [
      [statusError(500, 'server error', 1234), 1234],
      [
        {
          kind: 'rate_limit',
          statusCode: 429,
          message: 'rate limited',
          requestId: null,
          retryAfterMs: 2000,
          headers: null,
        },
        2000,
      ],
    ];
    for (const [error, delayMs] of cases) {
      const { requester } = createStubRequester([error, 'ok']);
      const { retrying } = startRetryingActor(requester, { maxAttemptsPerStep: 3 });

      await flush();

      expect(retrying).toHaveLength(1);
      expect((retrying[0] as RetryingEvent).delayMs).toBe(delayMs);
    }
  });

  it('falls back to the backoff delay without retryAfterMs', async () => {
    const { requester } = createStubRequester([statusError(500, 'server error'), 'ok']);
    const { retrying } = startRetryingActor(requester, { maxAttemptsPerStep: 3 });

    await flush();

    expect(retrying).toHaveLength(1);
    const delayMs = (retrying[0] as RetryingEvent).delayMs;
    expect(delayMs).toBeGreaterThanOrEqual(500);
    expect(delayMs).toBeLessThanOrEqual(625);
  });

  it('does not honor retryAfterMs on a non-retryable error', async () => {
    const error: LlmErrorMessage = {
      kind: 'quota_exhausted',
      statusCode: 429,
      message: 'quota exceeded',
      requestId: null,
      retryAfterMs: 1000,
      headers: null,
    };
    const { requester, calls } = createStubRequester([error]);
    const { actor, retrying } = startRetryingActor(requester, { maxAttemptsPerStep: 5 });

    await flush();

    expect(retrying).toHaveLength(0);
    expect(calls()).toBe(1);
    expect(actor.getSnapshot().value).toBe('failed');
  });

  it('does not retry without failure', async () => {
    const { requester, calls } = createStubRequester(['ok']);
    const { actor, retrying } = startRetryingActor(requester, { maxAttemptsPerStep: 5 });

    await flush();

    expect(actor.getSnapshot().value).toBe('succeeded');
    expect(retrying).toHaveLength(0);
    expect(calls()).toBe(1);
  });
});

type RecoveringEvent = Extract<LlmEvent, { type: 'llm.recovering' }>;
type SentEvent = Extract<LlmEvent, { type: 'llm.sent' }>;

function tooLargeError(): LlmErrorMessage {
  return {
    kind: 'request_too_large',
    statusCode: 413,
    message: 'request entity too large',
    requestId: null,
    retryAfterMs: null,
    headers: null,
  };
}

function imageFormatError(): LlmErrorMessage {
  return {
    kind: 'image_format',
    statusCode: 400,
    message: 'unsupported image format',
    requestId: null,
    retryAfterMs: null,
    headers: null,
  };
}

function mediaMessage(text: string, images: number): Message {
  const content: ContentPart[] = [{ type: 'text', text }];
  for (let index = 0; index < images; index += 1) {
    content.push({ type: 'image_url', imageUrl: { url: `media://img-${text}-${index}` } });
  }
  return { role: 'user', content };
}

function countImageParts(messages: readonly Message[]): number {
  return messages.reduce(
    (count, message) =>
      count + message.content.filter((part) => part.type === 'image_url').length,
    0,
  );
}

function createCapturingRequester(plan: readonly (LlmErrorMessage | 'ok')[]) {
  let calls = 0;
  const seen: (readonly Message[])[] = [];
  const requester: LlmRequester = {
    generate: (_config, content, control) => {
      seen.push(content.messages);
      const step = plan[Math.min(calls, plan.length - 1)];
      calls += 1;
      control.onEvent?.({ type: 'llm.sent' });
      if (step === 'ok') {
        control.onEvent?.({ type: 'llm.delta', part: { type: 'text', text: 'done' } });
        control.onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      }
      if (step.kind === 'syntax') {
        control.onEvent?.({ type: 'llm.failed.syntax', error: step });
        return Promise.resolve();
      }
      control.onEvent?.({ type: 'llm.failed.remote', error: step });
      return Promise.resolve();
    },
  };
  return { requester, calls: () => calls, seen };
}

async function drain(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await flush();
  }
}

describe('llm machine media recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('degrades then strips media across request_too_large failures before failing', async () => {
    const messages = [mediaMessage('a', 2), mediaMessage('b', 1), mediaMessage('c', 1)];
    const { requester, calls, seen } = createCapturingRequester([
      tooLargeError(),
      tooLargeError(),
      tooLargeError(),
    ]);
    const actor = createActor(
      createLlmMachine({ requester, recovery: createMediaDegradeRecovery() }),
      { input: { config: { model }, content: { messages } } },
    );
    const recovering: RecoveringEvent[] = [];
    const sent: SentEvent[] = [];
    const failed: unknown[] = [];
    actor.on('llm.recovering', (event) => recovering.push(event));
    actor.on('llm.sent', (event) => sent.push(event));
    actor.on('llm.failed.remote', (event) => failed.push(event.error));
    actor.start();

    await drain();

    expect(calls()).toBe(3);
    expect(actor.getSnapshot().value).toBe('failed');
    expect(recovering.map((event) => `${event.strategy}:${event.action}`)).toEqual([
      'media-degrade:degraded',
      'media-degrade:stripped',
    ]);
    expect(sent.map((event) => event.recovery?.action)).toEqual([
      undefined,
      'degraded',
      'stripped',
    ]);
    expect(failed).toHaveLength(1);
    expect(countImageParts(seen[0] ?? [])).toBe(4);
    expect(countImageParts(seen[1] ?? [])).toBe(2);
    expect(countImageParts(seen[2] ?? [])).toBe(0);
  });

  it('succeeds with degraded media after a request_too_large error', async () => {
    const messages = [mediaMessage('a', 2), mediaMessage('b', 1), mediaMessage('c', 1)];
    const { requester, calls, seen } = createCapturingRequester([tooLargeError(), 'ok']);
    const actor = createActor(
      createLlmMachine({ requester, recovery: createMediaDegradeRecovery() }),
      { input: { config: { model }, content: { messages } } },
    );
    const recovering: RecoveringEvent[] = [];
    actor.on('llm.recovering', (event) => recovering.push(event));
    actor.start();

    await drain();

    expect(calls()).toBe(2);
    expect(actor.getSnapshot().value).toBe('succeeded');
    expect(recovering).toHaveLength(1);
    expect(countImageParts(seen[1] ?? [])).toBe(2);
  });

  it('strips media directly on image_format without degrading first', async () => {
    const messages = [mediaMessage('a', 2), mediaMessage('b', 1), mediaMessage('c', 1)];
    const { requester, calls, seen } = createCapturingRequester([imageFormatError(), 'ok']);
    const actor = createActor(
      createLlmMachine({ requester, recovery: createMediaDegradeRecovery() }),
      { input: { config: { model }, content: { messages } } },
    );
    const recovering: RecoveringEvent[] = [];
    const sent: SentEvent[] = [];
    actor.on('llm.recovering', (event) => recovering.push(event));
    actor.on('llm.sent', (event) => sent.push(event));
    actor.start();

    await drain();

    expect(calls()).toBe(2);
    expect(actor.getSnapshot().value).toBe('succeeded');
    expect(recovering.map((event) => `${event.strategy}:${event.action}`)).toEqual([
      'media-degrade:stripped',
    ]);
    expect(sent.map((event) => event.recovery?.action)).toEqual([undefined, 'stripped']);
    expect(countImageParts(seen[1] ?? [])).toBe(0);
  });

  it('fails immediately on request_too_large without media', async () => {
    const messages = [mediaMessage('plain', 0)];
    const { requester, calls } = createCapturingRequester([tooLargeError()]);
    const actor = createActor(
      createLlmMachine({ requester, recovery: createMediaDegradeRecovery() }),
      { input: { config: { model }, content: { messages } } },
    );
    const recovering: RecoveringEvent[] = [];
    actor.on('llm.recovering', (event) => recovering.push(event));
    actor.start();

    await drain();

    expect(calls()).toBe(1);
    expect(recovering).toHaveLength(0);
    expect(actor.getSnapshot().value).toBe('failed');
  });
});

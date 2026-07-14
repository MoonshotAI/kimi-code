import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APIConnectionError,
  APIProviderRateLimitError,
  APIStatusError,
} from '#/app/llmProtocol/errors';
import { emptyUsage } from '#/app/llmProtocol/usage';
import { IEventBus } from '#/app/event/eventBus';
import { retryBackoffDelays } from '#/_base/utils/retry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';

import { createTestAgent, llmGenerateServices, type TestAgentContext } from '../../harness';

describe('stepRetry plugin', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function rpcEvents(name: string) {
    return ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === name);
  }

  async function runTurn(turnId: number, signal?: AbortSignal) {
    ctx.get(IEventBus).publish({ type: 'turn.started', turnId, origin: { kind: 'user' } });
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const resultPromise = loop.run({ turnId, signal });
    await vi.runAllTimersAsync();
    return resultPromise;
  }

  it('retries a retryable provider error and resumes the same step number', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return {
          id: 'retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          turnId: 1,
          step: 1,
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 3,
          delayMs: expect.any(Number),
          errorName: 'APIConnectionError',
          errorMessage: 'terminated',
        }),
      }),
    ]);
    expect(
      rpcEvents('turn.step.started').map((event) => (event.args as { step: number }).step),
    ).toEqual([1, 2]);
    expect(rpcEvents('turn.step.interrupted')).toEqual([]);
    expect(ctx.contextData().history).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered' }],
      }),
    ]);
  });

  it('fails the turn after maxAttempts and reports the interruption only then', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(429, 'slow down');
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(3);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(2);
    expect(rpcEvents('turn.step.interrupted')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ reason: 'error', step: 3 }),
      }),
    ]);
  });

  it('honors the provider retry-after delay before retrying', async () => {
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIProviderRateLimitError('slow down', null, 1);
        return {
          id: 'retry-after-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    ctx.get(IEventBus).publish({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } });
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const result = await loop.run({ turnId: 1 });

    expect(result.type).toBe('completed');
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ delayMs: 1 }),
      }),
    ]);
  });

  it('does not retry a non-retryable error', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(401, 'unauthorized');
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('cancels the turn when aborted during the backoff wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        throw new APIConnectionError('terminated');
      }),
    );
    ctx.get(IEventBus).subscribe('turn.step.retrying', () => {
      controller.abort(new Error('stop'));
    });

    const result = await runTurn(1, controller.signal);

    expect(result.type).toBe('cancelled');
  });

  it('honors loop_control.max_retries_per_step', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(llmGenerateServices(async () => {
      calls += 1;
      throw new APIConnectionError('terminated');
    }), {
      initialConfig: { loopControl: { maxRetriesPerStep: 1 } },
    });

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('starts a fresh attempt budget on the next turn', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let failing = true;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        if (failing) {
          calls += 1;
          throw new APIConnectionError('terminated');
        }
        return {
          id: 'ok-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const first = await runTurn(1);
    expect(first.type).toBe('failed');
    expect(calls).toBe(3);

    failing = false;
    const second = await runTurn(2);
    expect(second).toEqual({ type: 'completed', steps: 1, truncated: false });
  });
});

describe('retryBackoffDelays', () => {
  it('starts at 500 milliseconds and doubles with up to 25 percent jitter', () => {
    const delays = retryBackoffDelays(3);

    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(625);
    expect(delays[1]).toBeGreaterThanOrEqual(1_000);
    expect(delays[1]).toBeLessThanOrEqual(1_250);
  });

  it('caps high-attempt backoff at 32 seconds plus up to 25 percent jitter', () => {
    const delays = retryBackoffDelays(10);

    expect(delays).toHaveLength(9);
    expect(delays[6]).toBeGreaterThanOrEqual(32_000);
    expect(delays[6]).toBeLessThanOrEqual(40_000);
    expect(delays[8]).toBeGreaterThanOrEqual(32_000);
    expect(delays[8]).toBeLessThanOrEqual(40_000);
  });
});

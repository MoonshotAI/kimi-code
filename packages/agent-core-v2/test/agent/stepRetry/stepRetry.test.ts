import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APIConnectionError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIStatusError,
} from '#/kosong/contract/errors';
import { SUBSTITUTE_MODEL_FLAG_ENV } from '#/session/substitute/flag';
import { FALLBACK_MODEL_FLAG_ENV } from '#/session/fallback/flag';
import { emptyUsage } from '#/kosong/contract/usage';
import { IEventBus } from '#/app/event/eventBus';
import { retryBackoffDelays } from '#/_base/utils/retry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnStepRetrying } from '#/agent/stepRetry/stepRetryService';

import { createTestAgent, llmGenerateServices, type TestAgentContext } from '../../harness';

const realSetTimeout = globalThis.setTimeout;

describe('stepRetry plugin', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      vi.unstubAllEnvs();
    }
  });

  function rpcEvents(name: string) {
    return ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === name);
  }

  function wireLoopEvents(eventType: string): Array<Record<string, unknown>> {
    return ctx.allEvents
      .filter(
        (entry) =>
          entry.type === '[wire]' &&
          entry.event === 'context.append_loop_event' &&
          (entry.args as { event?: { type?: string } }).event?.type === eventType,
      )
      .map((entry) => (entry.args as { event: Record<string, unknown> }).event);
  }

  async function runTurn(turnId: number, signal?: AbortSignal) {
    void ctx.dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const resultPromise = loop.run({ turnId, signal });
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 100; i += 1) {
      if (settled) break;
      await vi.runAllTimersAsync();
      if (!settled) {
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
    }
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
          maxAttempts: 10,
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

  it('pairs every retried step.begin with a step.end in the wire', async () => {
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
    const begins = wireLoopEvents('step.begin');
    const ends = wireLoopEvents('step.end');
    expect(begins).toHaveLength(2);
    expect(ends.map((event) => event['finishReason'])).toEqual(['error', 'end_turn']);
    expect(ends.map((event) => event['uuid'])).toEqual(begins.map((event) => event['uuid']));
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
    expect(calls).toBe(10);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(9);
    expect(rpcEvents('turn.step.interrupted')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ reason: 'error', step: 10 }),
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

    void ctx.dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
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
    ctx.get(IEventBus).subscribe(TurnStepRetrying, () => {
      controller.abort(new Error('stop'));
    });

    const result = await runTurn(1, controller.signal);

    expect(result.type).toBe('cancelled');
  });

  it('honors loop_control.max_attempts_per_step', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(llmGenerateServices(async () => {
      calls += 1;
      throw new APIConnectionError('terminated');
    }), {
      initialConfig: { loopControl: { maxAttemptsPerStep: 1 } },
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
    expect(calls).toBe(10);

    failing = false;
    const second = await runTurn(2);
    expect(second).toEqual({ type: 'completed', steps: 1, truncated: false });
  });

  it('retries any request error inside the request when KIMI_CODE_INFINITE_RETRY is set', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KIMI_CODE_INFINITE_RETRY', '1');
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIStatusError(400, 'endpoint broken');
        if (calls === 2) throw new APIStatusError(404, 'model not found');
        if (calls === 3) throw new APIStatusError(429, 'slow down');
        return {
          id: 'infinite-retry-response',
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

    expect(result).toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(calls).toBe(4);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
    expect(rpcEvents('turn.step.interrupted')).toEqual([]);
  });

  it('keeps retrying past the per-step attempt budget when KIMI_CODE_INFINITE_RETRY is set', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KIMI_CODE_INFINITE_RETRY', '1');
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls <= 12) throw new APIStatusError(429, 'slow down');
        return {
          id: 'infinite-retry-response',
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

    expect(result).toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(calls).toBe(13);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('cancels the turn when aborted during an infinite retry backoff', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KIMI_CODE_INFINITE_RETRY', '1');
    const controller = new AbortController();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(400, 'endpoint broken');
      }),
    );
    setTimeout(() => controller.abort(new Error('stop')), 100);

    const result = await runTurn(1, controller.signal);

    expect(result.type).toBe('cancelled');
    expect(calls).toBe(1);
  });
});

describe('substitute model fallback', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      vi.unstubAllEnvs();
    }
  });

  const SUBSTITUTE_CONFIG = {
    models: {
      'kimi/substitute': {
        provider: 'test-provider',
        model: 'substitute-model',
        maxContextSize: 256_000,
        capabilities: ['thinking', 'tool_use'],
      },
    },
    substituteModel: { defaultModel: 'kimi/substitute' },
  };

  function okResponse(id: string, text: string) {
    return {
      id,
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text }],
        toolCalls: [],
      },
      usage: emptyUsage(),
      finishReason: 'completed' as const,
      rawFinishReason: 'stop',
    };
  }

  function rpcEvents(name: string) {
    return ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === name);
  }

  async function runTurn(turnId: number) {
    void ctx.dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const resultPromise = loop.run({ turnId });
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 100; i += 1) {
      if (settled) break;
      await vi.runAllTimersAsync();
      if (!settled) {
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
    }
    return resultPromise;
  }

  it('switches to the substitute model immediately on a 429 rate limit', async () => {
    vi.useFakeTimers();
    vi.stubEnv(SUBSTITUTE_MODEL_FLAG_ENV, 'true');
    const modelsSeen: string[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async (chat) => {
        modelsSeen.push(chat.modelName);
        if (chat.modelName !== 'substitute-model') {
          throw new APIProviderRateLimitError('slow down', null, null);
        }
        return okResponse('substitute-response', 'answered by substitute');
      }),
      { initialConfig: SUBSTITUTE_CONFIG },
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(modelsSeen).toEqual(['mock-model', 'substitute-model']);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
    expect(rpcEvents('warning')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          code: 'substitute-model',
          message: expect.stringContaining('switching to substitute model kimi/substitute'),
        }),
      }),
    ]);
  });

  it('switches to the substitute model on quota exhaustion without burning retries', async () => {
    vi.useFakeTimers();
    vi.stubEnv(SUBSTITUTE_MODEL_FLAG_ENV, 'true');
    const modelsSeen: string[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async (chat) => {
        modelsSeen.push(chat.modelName);
        if (chat.modelName !== 'substitute-model') {
          throw new APIProviderQuotaExhaustedError('quota exhausted', null, null);
        }
        return okResponse('quota-substitute-response', 'answered by substitute');
      }),
      { initialConfig: SUBSTITUTE_CONFIG },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('completed');
    expect(modelsSeen).toEqual(['mock-model', 'substitute-model']);
  });

  it('does not substitute for non-rate-limit errors; the turn fails after retries', async () => {
    vi.useFakeTimers();
    vi.stubEnv(SUBSTITUTE_MODEL_FLAG_ENV, 'true');
    const modelsSeen: string[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async (chat) => {
        modelsSeen.push(chat.modelName);
        throw new APIConnectionError('fetch failed');
      }),
      { initialConfig: SUBSTITUTE_CONFIG },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(new Set(modelsSeen)).toEqual(new Set(['mock-model']));
    expect(modelsSeen).toHaveLength(10);
  });

  it('does not substitute when the flag is off', async () => {
    vi.useFakeTimers();
    const modelsSeen: string[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async (chat) => {
        modelsSeen.push(chat.modelName);
        throw new APIStatusError(429, 'slow down');
      }),
      { initialConfig: SUBSTITUTE_CONFIG },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(new Set(modelsSeen)).toEqual(new Set(['mock-model']));
  });

  it('returns to the primary model after the cooldown expires and announces it', async () => {
    vi.useFakeTimers();
    vi.stubEnv(SUBSTITUTE_MODEL_FLAG_ENV, 'true');
    let primaryFailures = 0;
    const modelsSeen: string[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async (chat) => {
        modelsSeen.push(chat.modelName);
        if (chat.modelName === 'substitute-model') {
          return okResponse('substitute-response', 'answered by substitute');
        }
        if (primaryFailures === 0) {
          primaryFailures += 1;
          throw new APIProviderRateLimitError('slow down', null, null);
        }
        return okResponse('primary-response', 'answered by primary');
      }),
      {
        initialConfig: {
          ...SUBSTITUTE_CONFIG,
          substituteModel: { defaultModel: 'kimi/substitute', cooldownMs: 60_000 },
        },
      },
    );

    const first = await runTurn(1);
    expect(first.type).toBe('completed');
    expect(modelsSeen).toEqual(['mock-model', 'substitute-model']);

    const second = await runTurn(2);
    expect(second.type).toBe('completed');
    expect(modelsSeen).toEqual(['mock-model', 'substitute-model', 'substitute-model']);

    vi.advanceTimersByTime(61_000);
    const third = await runTurn(3);
    expect(third.type).toBe('completed');
    expect(modelsSeen).toEqual([
      'mock-model',
      'substitute-model',
      'substitute-model',
      'mock-model',
    ]);
    expect(rpcEvents('warning')).toContainEqual(
      expect.objectContaining({
        args: expect.objectContaining({
          code: 'substitute-model',
          message: expect.stringContaining('cooldown ended'),
        }),
      }),
    );
  });

  it('re-arms substitution when the primary rate-limits again after the cooldown', async () => {
    vi.useFakeTimers();
    vi.stubEnv(SUBSTITUTE_MODEL_FLAG_ENV, 'true');
    const modelsSeen: string[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async (chat) => {
        modelsSeen.push(chat.modelName);
        if (chat.modelName === 'substitute-model') {
          return okResponse('substitute-response', 'answered by substitute');
        }
        throw new APIProviderRateLimitError('slow down', null, null);
      }),
      {
        initialConfig: {
          ...SUBSTITUTE_CONFIG,
          substituteModel: { defaultModel: 'kimi/substitute', cooldownMs: 60_000 },
        },
      },
    );

    const first = await runTurn(1);
    expect(first.type).toBe('completed');

    vi.advanceTimersByTime(61_000);
    const second = await runTurn(2);
    expect(second.type).toBe('completed');
    expect(modelsSeen).toEqual([
      'mock-model',
      'substitute-model',
      'mock-model',
      'substitute-model',
    ]);
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

describe('fallback model cascade', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      vi.unstubAllEnvs();
    }
  });

  const FALLBACK_CONFIG = {
    models: {
      'kimi/fallback': {
        provider: 'test-provider',
        model: 'fallback-model',
        maxContextSize: 256_000,
        capabilities: ['thinking', 'tool_use'],
      },
      'kimi/fallback-secondary': {
        provider: 'test-provider',
        model: 'fallback-model-secondary',
        maxContextSize: 256_000,
        capabilities: ['thinking', 'tool_use'],
      },
    },
    fallbackModel: { model: 'kimi/fallback', secondaryModel: 'kimi/fallback-secondary' },
  };

  function okResponse(id: string, text: string) {
    return {
      id,
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text }],
        toolCalls: [],
      },
      usage: emptyUsage(),
      finishReason: 'completed' as const,
      rawFinishReason: 'stop',
    };
  }

  function rpcEvents(name: string) {
    return ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === name);
  }

  async function runTurn(turnId: number) {
    void ctx.dispatcher.dispatch(new TurnStarted({ agentId: 'main', turnId, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const resultPromise = loop.run({ turnId });
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 200; i += 1) {
      if (settled) break;
      await vi.runAllTimersAsync();
      if (!settled) {
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
    }
    return resultPromise;
  }

  it('U1: retries on the fallback model after the primary exhausts its retry budget', async () => {
    vi.useFakeTimers();
    vi.stubEnv(FALLBACK_MODEL_FLAG_ENV, 'true');
    const modelsSeen: string[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async (chat) => {
        modelsSeen.push(chat.modelName);
        if (chat.modelName === 'mock-model') {
          throw new APIConnectionError('primary down');
        }
        return okResponse('fallback-response', 'answered by fallback');
      }),
      { initialConfig: FALLBACK_CONFIG },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('completed');
    expect(modelsSeen.filter((name) => name === 'mock-model')).toHaveLength(10);
    expect(modelsSeen).toContain('fallback-model');
    expect(rpcEvents('warning')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          code: 'fallback-model',
          message: expect.stringContaining('fallback model kimi/fallback'),
        }),
      }),
    ]);
  });

  it('U2: advances to the secondary fallback after both prior tiers exhaust retries', async () => {
    vi.useFakeTimers();
    vi.stubEnv(FALLBACK_MODEL_FLAG_ENV, 'true');
    const modelsSeen: string[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async (chat) => {
        modelsSeen.push(chat.modelName);
        if (chat.modelName !== 'fallback-model-secondary') {
          throw new APIConnectionError('down');
        }
        return okResponse('secondary-fallback-response', 'answered by secondary fallback');
      }),
      { initialConfig: FALLBACK_CONFIG },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('completed');
    expect(modelsSeen.filter((name) => name === 'mock-model')).toHaveLength(10);
    expect(modelsSeen.filter((name) => name === 'fallback-model')).toHaveLength(10);
    expect(modelsSeen).toContain('fallback-model-secondary');
    expect(rpcEvents('warning')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          code: 'fallback-model',
          message: expect.stringContaining('tier: primary'),
        }),
      }),
      expect.objectContaining({
        args: expect.objectContaining({
          code: 'fallback-model',
          message: expect.stringContaining('tier: secondary'),
        }),
      }),
    ]);
  });

  it('U3: does not activate the cascade when no fallback is configured', async () => {
    vi.useFakeTimers();
    vi.stubEnv(FALLBACK_MODEL_FLAG_ENV, 'true');
    const modelsSeen: string[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async (chat) => {
        modelsSeen.push(chat.modelName);
        throw new APIConnectionError('primary down');
      }),
      { initialConfig: { models: FALLBACK_CONFIG.models } },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(modelsSeen).toEqual(['mock-model', 'mock-model', 'mock-model', 'mock-model', 'mock-model', 'mock-model', 'mock-model', 'mock-model', 'mock-model', 'mock-model']);
    expect(rpcEvents('warning')).toEqual([]);
  });
});

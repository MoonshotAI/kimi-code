import { describe, expect, it, vi } from 'vitest';

import { userCancellationReason } from '#/_base/utils/abort';
import { APIProviderQuotaExhaustedError, APIProviderRateLimitError, APIStatusError } from '#/llm-adapter/contract/errors';
import { createUserMessage } from '@moonshot-ai/core/llm/message';
import type { LlmOutcome, LlmRunEvent } from '@moonshot-ai/core/llm/response';

import {
  ARTEX_COOLDOWN_LADDER_MS,
  ARTEX_DEFAULT_SOFT_TRIP_THRESHOLD,
  ARTEX_POOL_RANK_ACTIVE,
  ArtexLlmHealthRegistry,
  ArtexLlmPool,
  ArtexLlmPoolExhaustedError,
  ArtexTokenBucket,
  estimateTokens,
  executeWithFailover,
  extractLlmRunTerminalError,
  isHardLlmFailure,
  isLlmRunOutputEvent,
  shouldFailoverLlmError,
  streamWithFailover,
  validateUserAgent,
  type ArtexLlmPoolMember,
} from './index';

function makeMember(
  id: string,
  rank: number,
  overrides: Partial<ArtexLlmPoolMember> = {},
): ArtexLlmPoolMember {
  return {
    id,
    name: `profile-${id}`,
    model: `model-${id}`,
    format: 'openai',
    rank,
    ...overrides,
  };
}

describe('ArtexLlmHealthRegistry', () => {
  it('trips immediately on deterministic 401/402/403/404 and quota_exhausted errors', () => {
    for (const status of [401, 402, 403, 404]) {
      const reg = new ArtexLlmHealthRegistry({ now: () => 1_000 });
      const err = new APIStatusError(status, `status ${String(status)}`, false);
      expect(isHardLlmFailure(err)).toBe(true);
      expect(reg.recordFailure('p1', err)).toBe(true);
      expect(reg.isHealthy('p1')).toBe(false);
    }

    const regQuota = new ArtexLlmHealthRegistry({ now: () => 1_000 });
    const quotaErr = new APIProviderQuotaExhaustedError('insufficient_quota');
    expect(isHardLlmFailure(quotaErr)).toBe(true);
    expect(regQuota.recordFailure('p1', quotaErr)).toBe(true);
    expect(regQuota.isHealthy('p1')).toBe(false);
  });

  it('soft-trips transient 429/5xx/network errors only after 3 consecutive failures', () => {
    let now = 10_000;
    const reg = new ArtexLlmHealthRegistry({ now: () => now });
    const rateLimit = new APIProviderRateLimitError('Rate limited');
    expect(isHardLlmFailure(rateLimit)).toBe(false);

    for (let i = 1; i < ARTEX_DEFAULT_SOFT_TRIP_THRESHOLD; i += 1) {
      expect(reg.recordFailure('p1', rateLimit)).toBe(false);
      expect(reg.isHealthy('p1')).toBe(true);
    }
    expect(reg.recordFailure('p1', rateLimit)).toBe(true);
    expect(reg.isHealthy('p1')).toBe(false);

    now += ARTEX_COOLDOWN_LADDER_MS[0]!;
    expect(reg.isHealthy('p1')).toBe(true);
  });

  it('follows the 1m -> 5m -> 30m cooldown ladder and resets on recordSuccess / reset', () => {
    let now = 1_000;
    const reg = new ArtexLlmHealthRegistry({ now: () => now });
    const hardErr = new APIStatusError(402, 'payment required', false);

    reg.recordFailure('p1', hardErr);
    expect(reg.get('p1')?.trips).toBe(1);
    expect(reg.get('p1')?.openUntilMs).toBe(now + 60_000);

    now += 60_000;
    expect(reg.isHealthy('p1')).toBe(true);
    reg.recordFailure('p1', hardErr);
    expect(reg.get('p1')?.trips).toBe(2);
    expect(reg.get('p1')?.openUntilMs).toBe(now + 5 * 60_000);

    now += 5 * 60_000;
    reg.recordFailure('p1', hardErr);
    expect(reg.get('p1')?.trips).toBe(3);
    expect(reg.get('p1')?.openUntilMs).toBe(now + 30 * 60_000);

    now += 30 * 60_000;
    reg.recordFailure('p1', hardErr);
    expect(reg.get('p1')?.trips).toBe(4);
    expect(reg.get('p1')?.openUntilMs).toBe(now + 30 * 60_000);

    expect(reg.snapshot()['p1']?.trips).toBe(4);
    reg.recordSuccess('p1');
    expect(reg.snapshot()['p1']).toBeUndefined();
    expect(reg.isHealthy('p1')).toBe(true);

    reg.recordFailure('p1', hardErr);
    expect(reg.isHealthy('p1')).toBe(false);
    reg.reset('p1');
    expect(reg.isHealthy('p1')).toBe(true);
  });

  it('honors custom policy thresholds and fixed cooldowns', () => {
    let now = 5_000;
    const reg = new ArtexLlmHealthRegistry({
      now: () => now,
      policy: { softTripThreshold: 2, cooldownMs: 90_000 },
    });
    expect(reg.recordFailure('p1', new Error('500 error'))).toBe(false);
    expect(reg.recordFailure('p1', new Error('500 error'))).toBe(true);
    expect(reg.get('p1')?.openUntilMs).toBe(now + 90_000);

    reg.setPolicy({ softTripThreshold: -1, cooldownMs: 0 });
    reg.reset('p1');
    for (let i = 0; i < 10; i += 1) {
      expect(reg.recordFailure('p1', new APIProviderRateLimitError('429'))).toBe(false);
    }
    expect(reg.isHealthy('p1')).toBe(true);
    expect(reg.recordFailure('p1', new APIStatusError(401, 'bad key', false))).toBe(true);
    expect(reg.get('p1')?.openUntilMs).toBe(now + 60_000);
  });
});

describe('shouldFailoverLlmError', () => {
  it('classifies failover eligibility by error kind, status, and abort state', () => {
    const controller = new AbortController();
    controller.abort(userCancellationReason());
    expect(shouldFailoverLlmError(new Error('network reset'), controller.signal)).toBe(false);
    expect(shouldFailoverLlmError(userCancellationReason())).toBe(false);

    expect(shouldFailoverLlmError(new APIStatusError(400, 'bad request', false))).toBe(false);
    expect(shouldFailoverLlmError(new APIStatusError(401, 'unauthorized', false))).toBe(true);
    expect(shouldFailoverLlmError(new APIStatusError(402, 'no credit', false))).toBe(true);
    expect(shouldFailoverLlmError(new APIStatusError(403, 'forbidden', false))).toBe(true);
    expect(shouldFailoverLlmError(new APIStatusError(404, 'not found', false))).toBe(true);
    expect(shouldFailoverLlmError(new APIStatusError(408, 'timeout', true))).toBe(true);
    expect(shouldFailoverLlmError(new APIStatusError(429, 'rate limit', true))).toBe(true);
    expect(shouldFailoverLlmError(new APIStatusError(503, 'unavailable', true))).toBe(true);
    expect(shouldFailoverLlmError(new Error('ECONNRESET'))).toBe(true);

    const overflowOutcome: LlmOutcome = {
      type: 'failed',
      error: {
        kind: 'context_overflow',
        message: 'too long',
        statusCode: 400,
        requestId: null,
        retryAfterMs: null,
        headers: null,
        retryable: false,
      },
    };
    expect(shouldFailoverLlmError(overflowOutcome)).toBe(false);
  });
});

describe('ArtexTokenBucket and header utilities', () => {
  it('enforces rps/rpm limits across concurrent callers without starving', async () => {
    vi.useFakeTimers();
    try {
      const bucket = new ArtexTokenBucket({ rps: 2, burst: 2 }, () => Date.now());
      expect(bucket.tryAcquire()).toBe(true);
      expect(bucket.tryAcquire()).toBe(true);
      expect(bucket.tryAcquire()).toBe(false);

      let acquired = 0;
      const p1 = bucket.acquire().then(() => {
        acquired += 1;
      });
      const p2 = bucket.acquire().then(() => {
        acquired += 1;
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(acquired).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(acquired).toBe(1);

      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([p1, p2]);
      expect(acquired).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates user-agent values and injects sticky session headers', () => {
    expect(validateUserAgent('  artex/1.0  ')).toBe('artex/1.0');
    expect(validateUserAgent('   ')).toBe('');
    expect(() => validateUserAgent('bad\r\nheader')).toThrow(/control character/);
    expect(() => validateUserAgent('x'.repeat(257))).toThrow(/too long/);

    const pool = new ArtexLlmPool([
      makeMember('a', 10, { sessionHeaderKey: 'x-opencode-session', userAgent: 'artex/2.0' }),
    ]);
    expect(pool.buildHeaders(pool.head()!, 'exp1-worker-i3', { authorization: 'Bearer k' })).toEqual({
      authorization: 'Bearer k',
      'x-opencode-session': 'exp1-worker-i3',
      'user-agent': 'artex/2.0',
    });
  });
});

describe('ArtexLlmPool failover, rotation, and filtering', () => {
  it('returns undefined from ArtexLlmPool.create when empty', () => {
    expect(ArtexLlmPool.create([])).toBeUndefined();
  });

  it('rotates equal-rank members across concurrent selections while pinning head rank', () => {
    const pool = new ArtexLlmPool([
      makeMember('head', ARTEX_POOL_RANK_ACTIVE),
      makeMember('k1', 10),
      makeMember('k2', 10),
      makeMember('k3', 10),
      makeMember('fallback', 1),
    ]);

    const secondIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const order = pool.selectCandidates();
      expect(order[0]!.id).toBe('head');
      expect(order[4]!.id).toBe('fallback');
      secondIds.push(order[1]!.id);
    }
    expect(new Set(secondIds)).toEqual(new Set(['k1', 'k2', 'k3']));
  });

  it('skips members whose maxContextTokens cannot hold the estimated request', () => {
    const pool = new ArtexLlmPool([
      makeMember('small', 20, { maxContextTokens: 1_000 }),
      makeMember('big', 10, { maxContextTokens: 1_000_000 }),
    ]);
    const bigMessage = createUserMessage('x'.repeat(50_000));
    expect(estimateTokens({ messages: [bigMessage] })).toBeGreaterThan(1_000);

    const candidates = pool.selectCandidates({ messages: [bigMessage] });
    expect(candidates.map((m) => m.id)).toEqual(['big']);
  });

  it('probes the head as last resort when all members are tripped or filtered', () => {
    const health = new ArtexLlmHealthRegistry({ now: () => 1_000 });
    health.recordFailure('a', new APIStatusError(402, 'no credit', false));
    health.recordFailure('b', new APIStatusError(402, 'no credit', false));
    const pool = new ArtexLlmPool([makeMember('a', 10), makeMember('b', 5)], { health });

    expect(pool.selectCandidates().map((m) => m.id)).toEqual(['a']);
  });

  it('executeWithFailover fails over on 402/quota errors and trips breaker immediately', async () => {
    const now = 1_000;
    const pool = new ArtexLlmPool(
      [makeMember('a', 10), makeMember('b', 5)],
      { now: () => now },
    );
    const calls: string[] = [];

    const first = await executeWithFailover(pool, {
      execute: async ({ member }) => {
        calls.push(member.id);
        if (member.id === 'a') {
          throw new APIProviderQuotaExhaustedError('insufficient_quota');
        }
        return 'ok-from-b';
      },
    });
    expect(first).toBe('ok-from-b');
    expect(calls).toEqual(['a', 'b']);
    expect(pool.health.isHealthy('a')).toBe(false);

    calls.length = 0;
    const second = await executeWithFailover(pool, {
      execute: async ({ member }) => {
        calls.push(member.id);
        return `ok-from-${member.id}`;
      },
    });
    expect(second).toBe('ok-from-b');
    expect(calls).toEqual(['b']);
  });

  it('executeWithFailover throws ArtexLlmPoolExhaustedError when all candidates fail', async () => {
    const pool = new ArtexLlmPool([makeMember('a', 10), makeMember('b', 5)]);
    await expect(
      executeWithFailover(pool, {
        execute: async ({ member }) => {
          throw new APIStatusError(402, `no credit on ${member.id}`, false);
        },
      }),
    ).rejects.toBeInstanceOf(ArtexLlmPoolExhaustedError);
  });

  it('streamWithFailover fails over before output chunk but surfaces mid-stream errors after output', async () => {
    const pool = new ArtexLlmPool([makeMember('a', 10), makeMember('b', 5)]);
    const attempts: string[] = [];

    const events: LlmRunEvent[] = [];
    for await (const ev of streamWithFailover<unknown, LlmRunEvent>(pool, {
      isOutputEvent: isLlmRunOutputEvent,
      isTerminalErrorEvent: extractLlmRunTerminalError,
      stream: async function* ({ member }) {
        attempts.push(member.id);
        yield {
          type: 'llm.started',
          provider: 'test',
          model: member.model,
          messageCount: 1,
        };
        if (member.id === 'a') {
          yield {
            type: 'llm.ended',
            outcome: {
              type: 'failed',
              error: {
                kind: 'quota_exhausted',
                message: 'billing exhausted',
                statusCode: 429,
                requestId: null,
                retryAfterMs: null,
                headers: null,
                retryable: false,
              },
            },
          };
          return;
        }
        yield { type: 'llm.streaming.part', part: { type: 'text', text: 'hello from b' } };
      },
    })) {
      events.push(ev);
    }
    expect(attempts).toEqual(['a', 'b']);
    expect(events.map((e) => e.type)).toEqual(['llm.started', 'llm.streaming.part']);

    const pool2 = new ArtexLlmPool([makeMember('a', 10), makeMember('b', 5)]);
    const attempts2: string[] = [];
    await expect(async () => {
      for await (const _ev of streamWithFailover<unknown, LlmRunEvent>(pool2, {
        isOutputEvent: isLlmRunOutputEvent,
        isTerminalErrorEvent: extractLlmRunTerminalError,
        stream: async function* ({ member }) {
          attempts2.push(member.id);
          yield { type: 'llm.streaming.part', part: { type: 'text', text: 'partial' } };
          throw new APIStatusError(500, 'mid-stream drop', true);
        },
      })) {
        // drain
      }
    }).rejects.toThrow(/mid-stream drop/);
    expect(attempts2).toEqual(['a']);
  });
});

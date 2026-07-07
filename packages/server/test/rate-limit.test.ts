/**
 * Auth-failure rate limiting (ROADMAP M6.4).
 *
 * Two layers:
 *   1. `createAuthFailureLimiter` unit behavior — failure counting, ban on
 *      threshold, ban expiry (fake timers), and window reset.
 *   2. `createAuthHook` integration — a banned source gets `429` (even with a
 *      valid token), a different source still gets `401`, and a hook without a
 *      limiter (the loopback wiring) never returns `429`.
 *
 * Distinct source IPs are expressed via `X-Forwarded-For` with Fastify
 * `trustProxy: true`, which is what `req.ip` reads behind a reverse proxy.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthHook } from '#/middleware/auth';
import {
  createAuthFailureLimiter,
  type AuthFailureLimiter,
} from '#/middleware/rateLimit';
import type { IAuthTokenService } from '#/services/auth/authTokenService';

const TOKEN = 'test-token';
const IP_A = '203.0.113.10';
const IP_B = '203.0.113.11';

function fixedImpl(): IAuthTokenService {
  return {
    _serviceBrand: undefined,
    getToken: () => TOKEN,
    isValid: async (candidate) => candidate === TOKEN,
  };
}

function buildApp(limiter?: AuthFailureLimiter): FastifyInstance {
  const app = Fastify({ trustProxy: true });
  app.addHook('onRequest', createAuthHook(fixedImpl(), { limiter }));
  app.get('/api/v1/sessions', async () => ({ ok: true }));
  return app;
}

function badToken(ip: string): { method: 'GET'; url: string; headers: Record<string, string> } {
  return {
    method: 'GET',
    url: '/api/v1/sessions',
    headers: { 'x-forwarded-for': ip, authorization: 'Bearer wrong-token' },
  };
}

describe('createAuthHook rate limiting (M6.4)', () => {
  let app: FastifyInstance;
  let limiter: AuthFailureLimiter;

  beforeEach(async () => {
    limiter = createAuthFailureLimiter({ maxFailures: 3, windowMs: 60_000, banMs: 60_000 });
    app = buildApp(limiter);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    limiter.dispose();
  });

  it('returns 401 for the first N failures, then 429 on the (N+1)th from the same IP', async () => {
    expect((await app.inject(badToken(IP_A))).statusCode).toBe(401);
    expect((await app.inject(badToken(IP_A))).statusCode).toBe(401);
    expect((await app.inject(badToken(IP_A))).statusCode).toBe(401);
    const fourth = await app.inject(badToken(IP_A));
    expect(fourth.statusCode).toBe(429);
    const body = fourth.json() as Record<string, unknown>;
    expect(body['code']).toBe(42901);
    expect(body['msg']).toBe('Too many failed auth attempts');
  });

  it('does not ban a different IP that has not hit the threshold', async () => {
    // Push IP_A over the threshold.
    await app.inject(badToken(IP_A));
    await app.inject(badToken(IP_A));
    await app.inject(badToken(IP_A));
    expect((await app.inject(badToken(IP_A))).statusCode).toBe(429);

    // IP_B is a fresh source — still 401, not 429.
    expect((await app.inject(badToken(IP_B))).statusCode).toBe(401);
  });

  it('returns 429 to a banned IP even when it presents a valid token', async () => {
    await app.inject(badToken(IP_A));
    await app.inject(badToken(IP_A));
    await app.inject(badToken(IP_A));
    expect((await app.inject(badToken(IP_A))).statusCode).toBe(429);

    const valid = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { 'x-forwarded-for': IP_A, authorization: `Bearer ${TOKEN}` },
    });
    expect(valid.statusCode).toBe(429);
  });

  it('never returns 429 when no limiter is wired (loopback behavior)', async () => {
    const noLimiterApp = buildApp(undefined);
    await noLimiterApp.ready();
    try {
      for (let i = 0; i < 10; i += 1) {
        expect((await noLimiterApp.inject(badToken(IP_A))).statusCode).toBe(401);
      }
    } finally {
      await noLimiterApp.close();
    }
  });
});

describe('createAuthFailureLimiter (unit)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bans a source at the threshold and clears the ban after banMs', () => {
    vi.useFakeTimers();
    const limiter = createAuthFailureLimiter({ maxFailures: 2, windowMs: 1_000, banMs: 500 });
    try {
      expect(limiter.isBanned('1.2.3.4')).toBe(false);
      limiter.recordFailure('1.2.3.4');
      expect(limiter.isBanned('1.2.3.4')).toBe(false);
      limiter.recordFailure('1.2.3.4');
      expect(limiter.isBanned('1.2.3.4')).toBe(true);

      vi.advanceTimersByTime(499);
      expect(limiter.isBanned('1.2.3.4')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(limiter.isBanned('1.2.3.4')).toBe(false);
    } finally {
      limiter.dispose();
    }
  });

  it('resets the failure count once the window elapses', () => {
    vi.useFakeTimers();
    const limiter = createAuthFailureLimiter({ maxFailures: 2, windowMs: 1_000, banMs: 500 });
    try {
      limiter.recordFailure('5.5.5.5');
      vi.advanceTimersByTime(1_001); // window expired → next failure starts fresh
      limiter.recordFailure('5.5.5.5');
      // Only one failure in the new window → not banned.
      expect(limiter.isBanned('5.5.5.5')).toBe(false);
    } finally {
      limiter.dispose();
    }
  });

  it('tracks sources independently', () => {
    vi.useFakeTimers();
    const limiter = createAuthFailureLimiter({ maxFailures: 1, windowMs: 1_000, banMs: 500 });
    try {
      limiter.recordFailure('9.9.9.9');
      expect(limiter.isBanned('9.9.9.9')).toBe(true);
      expect(limiter.isBanned('8.8.8.8')).toBe(false);
    } finally {
      limiter.dispose();
    }
  });
});

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthHook } from '../src/middleware/auth';
import {
  createAuthFailureLimiter,
  type AuthFailureLimiter,
} from '../src/middleware/rateLimit';
import type { IAuthTokenService } from '../src/services/auth/authTokenService';

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

describe('createAuthHook rate limiting', () => {
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
    await app.inject(badToken(IP_A));
    await app.inject(badToken(IP_A));
    await app.inject(badToken(IP_A));
    expect((await app.inject(badToken(IP_A))).statusCode).toBe(429);

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
      vi.advanceTimersByTime(1_001);
      limiter.recordFailure('5.5.5.5');
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

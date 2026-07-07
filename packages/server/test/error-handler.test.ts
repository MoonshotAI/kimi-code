/**
 * Error envelope hook (W4.3 / P0.13).
 *
 * Coverage:
 *   1. Unknown errors → 200 + envelope `code: 50001`, data: null, msg from err.
 *   2. `request_id` in envelope respects client-supplied `X-Request-Id` when valid.
 *   3. Malformed `X-Request-Id` → fresh ULID minted (regression test for the
 *      pre-W4 verbatim-echo behavior; security review demanded ULID-only).
 *   4. `/api/v1/healthz` smoke — success envelope shape stays byte-identical
 *      after the protocol re-export.
 *
 * Uses Fastify's built-in `.inject(...)` HTTP simulator — no socket binding,
 * no port, fully hermetic.
 */

import Fastify from 'fastify';
import { ulidRegex } from '@moonshot-ai/protocol';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { okEnvelope } from '../src/envelope';
import { installErrorHandler } from '../src/error-handler';
import { resolveRequestId } from '../src/request-id';

function buildApp() {
  const app = Fastify({
    loggerInstance: pino({ level: 'silent' }),
    disableRequestLogging: true,
    genReqId: (req) => resolveRequestId(req.headers as Record<string, string | string[] | undefined>),
  });
  installErrorHandler(app);
  app.get('/api/v1/healthz', async (req, reply) => reply.send(okEnvelope({ ok: true }, req.id)));
  app.get('/boom', async () => {
    throw new Error('oops something broke');
  });
  app.get('/boom-empty', async () => {
    const err = new Error('');
    throw err;
  });
  return app;
}

describe('error handler — envelope wrapping', () => {
  it('returns HTTP 200 with code 50001 envelope on unhandled exception', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body['code']).toBe(50001);
      expect(body['msg']).toBe('oops something broke');
      expect(body['data']).toBeNull();
      expect(typeof body['request_id']).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('falls back to "internal error" message when the thrown error has none', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/boom-empty' });
      const body = res.json() as Record<string, unknown>;
      expect(body['msg']).toBe('internal error');
    } finally {
      await app.close();
    }
  });
});

describe('request_id resolution at the REST boundary', () => {
  it('mints a bare ULID when no header is supplied (no req_ prefix)', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/healthz' });
      const body = res.json() as Record<string, unknown>;
      expect(body['code']).toBe(0);
      expect(body['data']).toEqual({ ok: true });
      const id = body['request_id'] as string;
      expect(id).not.toMatch(/^req_/); // PLAN P7 wire format change
      expect(ulidRegex.test(id)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('echoes client-supplied ULID verbatim when valid', async () => {
    const app = buildApp();
    try {
      const goodUlid = '01HQXY4Z2M3GZP6F8K9R5W7VBA'; // 26-char crockford
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/healthz',
        headers: { 'x-request-id': goodUlid },
      });
      const body = res.json() as Record<string, unknown>;
      expect(body['request_id']).toBe(goodUlid);
    } finally {
      await app.close();
    }
  });

  it('discards malformed X-Request-Id and mints a fresh ULID', async () => {
    // Regression for the pre-W4 verbatim-echo behavior. `req_garbage` is the
    // canonical bad input from the W1 reviewer's recommendation.
    const app = buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/healthz',
        headers: { 'x-request-id': 'req_garbage' },
      });
      const body = res.json() as Record<string, unknown>;
      const id = body['request_id'] as string;
      expect(id).not.toBe('req_garbage');
      expect(id).not.toMatch(/^req_/);
      expect(ulidRegex.test(id)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('also discards malformed input that happens to be the right length', async () => {
    const app = buildApp();
    try {
      // 26 chars but includes disallowed I/L/O/U per Crockford base32.
      const looksRight = 'IIIIIIIIIIIIIIIIIIIIIIIIII';
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/healthz',
        headers: { 'x-request-id': looksRight },
      });
      const id = (res.json() as Record<string, unknown>)['request_id'] as string;
      expect(id).not.toBe(looksRight);
      expect(ulidRegex.test(id)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('/api/v1/healthz envelope shape stability across the protocol re-export', () => {
  it('responds with the documented success envelope', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/healthz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      // Field order isn't a contract (JSON), but key set + types must hold.
      expect(Object.keys(body).sort()).toEqual(['code', 'data', 'msg', 'request_id']);
      expect(body['code']).toBe(0);
      expect(body['msg']).toBe('success');
      expect(body['data']).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});

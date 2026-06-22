import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuthHook } from '#/middleware/auth';
import type { IAuthTokenService } from '#/services/auth/authTokenService';

const TOKEN = 'test-token';

function fixedImpl(): IAuthTokenService {
  return {
    _serviceBrand: undefined,
    getToken: () => TOKEN,
    isValid: async (candidate) => candidate === TOKEN,
  };
}

describe('createAuthHook (onRequest middleware)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    app.addHook('onRequest', createAuthHook(fixedImpl()));

    app.get('/api/v1/healthz', async () => ({ ok: true }));
    app.get('/api/v1/sessions', async () => ({ ok: true }));
    app.options('/api/v1/sessions', async (_req, reply) =>
      reply.code(204).send(),
    );
    app.get('/', async () => ({ ok: true }));
    app.get('/openapi.json', async () => ({ openapi: '3.1.0' }));
    // Probe surfaces the post-hook header view so we can assert redaction.
    app.get('/api/v1/probe', async (req) => ({
      authorization: req.headers.authorization ?? null,
    }));

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('bypasses GET /api/v1/healthz with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects GET /api/v1/sessions with no token (40101 envelope)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sessions' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(40101);
    expect(body['msg']).toBe('Unauthorized');
    expect(body['data']).toBeNull();
    expect(typeof body['request_id']).toBe('string');
  });

  it('rejects GET /api/v1/sessions with a wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as Record<string, unknown>)['code']).toBe(40101);
  });

  it('accepts GET /api/v1/sessions with the correct bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { authorization: TOKEN },
    });
    expect(res.statusCode).toBe(401);
  });

  it('bypasses OPTIONS /api/v1/sessions with no token', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/sessions',
    });
    expect(res.statusCode).toBe(204);
  });

  it('bypasses GET / (static asset) with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
  });

  it('does NOT bypass GET /openapi.json (meta doc stays gated)', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(401);
    expect((res.json() as Record<string, unknown>)['code']).toBe(40101);
  });

  it('redacts the Authorization header view before the handler runs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { authorization: string | null };
    expect(body.authorization).toBe('[redacted]');
  });
});

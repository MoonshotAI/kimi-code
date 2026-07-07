/**
 * Origin / CORS middleware (ROADMAP M4.2).
 *
 * Pure unit cases for `originHost` / `isOriginAllowed` / `parseCorsOrigins`,
 * plus a minimal Fastify integration test that drives the `onRequest` hook
 * through `app.inject` and asserts the emitted (or withheld) CORS headers.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createOriginHook,
  isOriginAllowed,
  originHost,
  parseCorsOrigins,
} from '#/middleware/origin';

describe('originHost', () => {
  it('returns the host for a valid origin', () => {
    expect(originHost('https://foo.com')).toBe('foo.com');
  });

  it('drops the default port', () => {
    expect(originHost('http://localhost:80')).toBe('localhost');
  });

  it('keeps a non-default port', () => {
    expect(originHost('http://127.0.0.1:58627')).toBe('127.0.0.1:58627');
  });

  it('returns undefined for a missing origin', () => {
    expect(originHost(undefined)).toBeUndefined();
  });

  it('returns undefined for a malformed origin', () => {
    expect(originHost('not a url')).toBeUndefined();
  });
});

describe('isOriginAllowed', () => {
  it('allows same-origin', () => {
    expect(isOriginAllowed('http://localhost:80', 'localhost:80', [])).toBe(true);
  });

  it('denies cross-origin that is not whitelisted', () => {
    expect(isOriginAllowed('http://evil.com', 'localhost:80', [])).toBe(false);
  });

  it('allows cross-origin that is whitelisted', () => {
    expect(isOriginAllowed('https://foo.com', 'localhost:80', ['https://foo.com'])).toBe(true);
  });

  it('allows an absent origin', () => {
    expect(isOriginAllowed(undefined, 'localhost:80', [])).toBe(true);
  });

  it('treats a malformed origin as absent (allowed)', () => {
    expect(isOriginAllowed('not a url', 'h', [])).toBe(true);
  });
});

describe('parseCorsOrigins', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseCorsOrigins({ KIMI_CODE_CORS_ORIGINS: ' https://a.com, https://b.com, ' })).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('returns [] when unset', () => {
    expect(parseCorsOrigins({})).toEqual([]);
  });
});

describe('createOriginHook (onRequest hook)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    app.addHook('onRequest', createOriginHook({ allowedOrigins: ['https://foo.com'] }));
    app.get('/api/v1/probe', async () => ({ ok: true }));
    app.options('/api/v1/probe', async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('echoes CORS headers for a same-origin request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { origin: 'http://localhost:80', host: 'localhost:80' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:80');
  });

  it('echoes the whitelisted cross-origin and short-circuits OPTIONS to 204', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/probe',
      headers: { origin: 'https://foo.com', host: 'localhost:80' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://foo.com');
    expect(res.headers['access-control-allow-methods']).toBe(
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
  });

  it('withholds CORS headers for a non-whitelisted cross-origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { origin: 'http://evil.com', host: 'localhost:80' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns 204 without CORS headers for a non-whitelisted OPTIONS', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/probe',
      headers: { origin: 'http://evil.com', host: 'localhost:80' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('emits no CORS headers when Origin is absent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { host: 'localhost:80' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

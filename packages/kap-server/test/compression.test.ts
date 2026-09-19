import { gunzipSync } from 'node:zlib';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptsGzipEncoding,
  isGzipCompressibleType,
  registerResponseCompression,
} from '../src/middleware/compression';

const LARGE = JSON.stringify({ code: 0, data: { text: 'x'.repeat(4096) } });
const SMALL = JSON.stringify({ code: 0, data: { ok: true } });

describe('acceptsGzipEncoding', () => {
  it('honours explicit, wildcard and rejected gzip tokens', () => {
    expect(acceptsGzipEncoding(undefined)).toBe(false);
    expect(acceptsGzipEncoding('gzip, deflate, br')).toBe(true);
    expect(acceptsGzipEncoding('br;q=1.0, gzip;q=0.8')).toBe(true);
    expect(acceptsGzipEncoding('*')).toBe(true);
    expect(acceptsGzipEncoding('gzip;q=0')).toBe(false);
    expect(acceptsGzipEncoding('identity')).toBe(false);
    expect(acceptsGzipEncoding(['deflate', 'gzip'])).toBe(true);
  });
});

describe('isGzipCompressibleType', () => {
  it('accepts JSON and text types only', () => {
    expect(isGzipCompressibleType('application/json; charset=utf-8')).toBe(true);
    expect(isGzipCompressibleType('text/plain')).toBe(true);
    expect(isGzipCompressibleType('image/png')).toBe(false);
    expect(isGzipCompressibleType('application/octet-stream')).toBe(false);
    expect(isGzipCompressibleType(undefined)).toBe(false);
  });
});

describe('registerResponseCompression', () => {
  const app = Fastify();

  beforeAll(async () => {
    registerResponseCompression(app);
    app.get('/large', async (_req, reply) => {
      reply.type('application/json; charset=utf-8').send(LARGE);
    });
    app.get('/small', async (_req, reply) => {
      return reply.type('application/json; charset=utf-8').send(SMALL);
    });
    app.get('/binary', async (_req, reply) => {
      return reply.type('application/octet-stream').send(Buffer.alloc(4096, 1));
    });
    app.get('/partial', async (_req, reply) => {
      return reply.code(206).type('text/plain').send('y'.repeat(4096));
    });
    app.get('/encoded', async (_req, reply) => {
      return reply.type('application/json').header('content-encoding', 'br').send(LARGE);
    });
    app.get('/vary', async (_req, reply) => {
      return reply.type('application/json').header('vary', 'Origin').send(LARGE);
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('gzips large JSON bodies when the client accepts gzip', async () => {
    const res = await app.inject({ url: '/large', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toBe('Accept-Encoding');
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
    expect(res.rawPayload.length).toBeLessThan(Buffer.byteLength(LARGE));
    expect(gunzipSync(res.rawPayload).toString('utf8')).toBe(LARGE);
  });

  it('sends identity bodies when gzip is not accepted but still marks Vary', async () => {
    const res = await app.inject({ url: '/large' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['vary']).toBe('Accept-Encoding');
    expect(res.body).toBe(LARGE);
  });

  it('leaves small bodies untouched', async () => {
    const res = await app.inject({ url: '/small', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['vary']).toBeUndefined();
    expect(res.body).toBe(SMALL);
  });

  it('skips binary types, partial content and already-encoded bodies', async () => {
    const headers = { 'accept-encoding': 'gzip' };
    const binary = await app.inject({ url: '/binary', headers });
    expect(binary.headers['content-encoding']).toBeUndefined();
    expect(binary.rawPayload.length).toBe(4096);
    const partial = await app.inject({ url: '/partial', headers });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-encoding']).toBeUndefined();
    const encoded = await app.inject({ url: '/encoded', headers });
    expect(encoded.headers['content-encoding']).toBe('br');
    expect(encoded.body).toBe(LARGE);
  });

  it('appends Accept-Encoding to an existing Vary header', async () => {
    const res = await app.inject({ url: '/vary', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers['vary']).toBe('Origin, Accept-Encoding');
    expect(gunzipSync(res.rawPayload).toString('utf8')).toBe(LARGE);
  });
});

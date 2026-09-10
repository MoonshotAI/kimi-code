import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerWebAssetRoutes } from '../src/routes/webAssets';

const HASHED_JS = '/assets/index-Dy7xs5tu.js';
const HASHED_JS_SOURCE = `export const answer = 42;\n${'export {};\n'.repeat(64)}`;

describe('web asset routes', () => {
  let app: FastifyInstance;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'kimi-web-assets-'));
    await mkdir(join(assetsDir, 'assets'));
    await Promise.all([
      writeFile(join(assetsDir, 'index.html'), '<main>Kimi</main>'),
      writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js'), HASHED_JS_SOURCE),
      writeFile(
        join(assetsDir, 'assets', 'index-Dy7xs5tu.js.br'),
        brotliCompressSync(HASHED_JS_SOURCE),
      ),
      writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js.gz'), gzipSync(HASHED_JS_SOURCE)),
      writeFile(join(assetsDir, 'assets', 'application-configuration.json'), '{}'),
      writeFile(join(assetsDir, 'assets', 'engine-AbCdEf12.wasm'), Buffer.from([0, 0x61, 0x73])),
      writeFile(join(assetsDir, 'assets', 'font-AbCdEf12.woff'), Buffer.from('wOFF')),
      writeFile(join(assetsDir, 'assets', 'font-AbCdEf12.ttf'), Buffer.from([0, 1, 0, 0])),
      writeFile(join(assetsDir, 'assets', 'anim-AbCdEf12.riv'), Buffer.from('RIVE')),
      writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js.map'), '{"version":3}'),
      writeFile(join(assetsDir, 'favicon.svg'), '<svg></svg>'),
    ]);
    app = Fastify();
    await registerWebAssetRoutes(app, assetsDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(assetsDir, { recursive: true, force: true });
  });

  describe('cache policy', () => {
    it('caches content-hashed assets as immutable', async () => {
      const response = await app.inject({ method: 'GET', url: HASHED_JS });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it.each([
      '/index.html',
      '/sessions/active',
      '/favicon.svg',
      '/assets/application-configuration.json',
    ])('requires revalidation for %s', async (url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-cache');
    });
  });

  describe('content negotiation', () => {
    it('serves the brotli sibling when br is acceptable', async () => {
      const sibling = await stat(join(assetsDir, 'assets', 'index-Dy7xs5tu.js.br'));

      const response = await app.inject({
        method: 'GET',
        url: HASHED_JS,
        headers: { 'accept-encoding': 'gzip, deflate, br' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-encoding']).toBe('br');
      expect(response.headers['content-length']).toBe(String(sibling.size));
      expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(response.headers.vary).toBe('Accept-Encoding');
      expect(brotliDecompressSync(response.rawPayload).toString('utf8')).toBe(HASHED_JS_SOURCE);
    });

    it('serves the gzip sibling when only gzip is acceptable', async () => {
      const sibling = await stat(join(assetsDir, 'assets', 'index-Dy7xs5tu.js.gz'));

      const response = await app.inject({
        method: 'GET',
        url: HASHED_JS,
        headers: { 'accept-encoding': 'gzip' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.headers['content-length']).toBe(String(sibling.size));
      expect(gunzipSync(response.rawPayload).toString('utf8')).toBe(HASHED_JS_SOURCE);
    });

    it('falls back to gzip when br is excluded with q=0', async () => {
      const response = await app.inject({
        method: 'GET',
        url: HASHED_JS,
        headers: { 'accept-encoding': 'br;q=0, gzip' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-encoding']).toBe('gzip');
    });

    it('serves identity with Vary when no Accept-Encoding header is sent', async () => {
      const response = await app.inject({ method: 'GET', url: HASHED_JS });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers['content-length']).toBe(
        String(Buffer.byteLength(HASHED_JS_SOURCE)),
      );
      expect(response.headers.vary).toBe('Accept-Encoding');
      expect(response.body).toBe(HASHED_JS_SOURCE);
    });

    it('serves identity when the precompressed sibling is older than the source', async () => {
      const source = join(assetsDir, 'assets', 'index-Dy7xs5tu.js');
      const stale = new Date(Date.now() - 60_000);
      await Promise.all([
        utimes(`${source}.br`, stale, stale),
        utimes(`${source}.gz`, stale, stale),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: HASHED_JS,
        headers: { 'accept-encoding': 'gzip, br' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers.vary).toBe('Accept-Encoding');
      expect(response.body).toBe(HASHED_JS_SOURCE);
    });

    it('serves identity for files without precompressed siblings', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/favicon.svg',
        headers: { 'accept-encoding': 'gzip, br' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers.vary).toBe('Accept-Encoding');
      expect(response.body).toBe('<svg></svg>');
    });

    it('omits Vary on non-compressible types', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/assets/font-AbCdEf12.woff',
        headers: { 'accept-encoding': 'gzip, br' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.vary).toBeUndefined();
    });

    it('keeps the immutable cache policy on compressed variants', async () => {
      const response = await app.inject({
        method: 'GET',
        url: HASHED_JS,
        headers: { 'accept-encoding': 'br' },
      });

      expect(response.headers['content-encoding']).toBe('br');
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });
  });

  describe('conditional requests', () => {
    it('sends a weak ETag and Last-Modified on 200', async () => {
      const response = await app.inject({ method: 'GET', url: HASHED_JS });

      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
      expect(response.headers['last-modified']).toMatch(/GMT$/);
    });

    it('replies 304 without a body when If-None-Match matches', async () => {
      const first = await app.inject({ method: 'GET', url: HASHED_JS });
      const etag = first.headers.etag as string;

      const response = await app.inject({
        method: 'GET',
        url: HASHED_JS,
        headers: { 'if-none-match': `"stale", ${etag}` },
      });

      expect(response.statusCode).toBe(304);
      expect(response.body).toBe('');
      expect(response.headers.etag).toBe(etag);
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(response.headers.vary).toBe('Accept-Encoding');
    });

    it('replies 304 for a wildcard If-None-Match', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/index.html',
        headers: { 'if-none-match': '*' },
      });

      expect(response.statusCode).toBe(304);
      expect(response.body).toBe('');
    });

    it('uses a different ETag for the identity and brotli representations', async () => {
      const identity = await app.inject({ method: 'GET', url: HASHED_JS });
      const brotli = await app.inject({
        method: 'GET',
        url: HASHED_JS,
        headers: { 'accept-encoding': 'br' },
      });

      expect(brotli.headers.etag).toMatch(/-br"$/);
      expect(brotli.headers.etag).not.toBe(identity.headers.etag);
    });

    it('serves the full response for a stale ETag', async () => {
      const response = await app.inject({
        method: 'GET',
        url: HASHED_JS,
        headers: { 'if-none-match': 'W/"0-0"' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(HASHED_JS_SOURCE);
    });
  });

  describe('mime types', () => {
    it.each([
      ['/index.html', 'text/html; charset=utf-8'],
      [HASHED_JS, 'text/javascript; charset=utf-8'],
      ['/assets/application-configuration.json', 'application/json; charset=utf-8'],
      ['/assets/index-Dy7xs5tu.js.map', 'application/json; charset=utf-8'],
      ['/favicon.svg', 'image/svg+xml'],
      ['/assets/engine-AbCdEf12.wasm', 'application/wasm'],
      ['/assets/font-AbCdEf12.woff', 'font/woff'],
      ['/assets/font-AbCdEf12.ttf', 'font/ttf'],
      ['/assets/anim-AbCdEf12.riv', 'application/octet-stream'],
    ])('serves %s as %s', async (url, contentType) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe(contentType);
    });
  });
});

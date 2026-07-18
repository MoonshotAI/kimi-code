import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerWebAssetRoutes } from '../src/routes/webAssets';

describe('web asset cache policy', () => {
  let app: FastifyInstance;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'kimi-web-assets-'));
    await mkdir(join(assetsDir, 'assets'));
    await writeFile(join(assetsDir, 'index.html'), '<main>Kimi</main>');
    await writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js'), 'export {};');

    app = Fastify();
    await registerWebAssetRoutes(app, assetsDir);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('caches fingerprinted Vite assets as immutable', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/assets/index-Dy7xs5tu.js',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it.each(['/', '/index.html', '/sessions/current'])(
    'revalidates HTML responses for %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    },
  );
});

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
    await Promise.all([
      writeFile(
        join(assetsDir, 'index.html'),
        '<html><head><link rel="stylesheet" href="/assets/app.css"></head><body>Kimi</body></html>',
      ),
      writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js'), 'export {};'),
      writeFile(join(assetsDir, 'assets', 'application-configuration.json'), '{}'),
      writeFile(join(assetsDir, 'favicon.svg'), '<svg></svg>'),
    ]);
    app = Fastify();
    await registerWebAssetRoutes(app, assetsDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('caches content-hashed assets as immutable', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-Dy7xs5tu.js' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('injects the community skin stylesheet after the bundled app stylesheet', async () => {
    const response = await app.inject({ method: 'GET', url: '/sessions/active' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('href="/community-skins.css"');
    expect(response.body.indexOf('/assets/app.css')).toBeLessThan(
      response.body.indexOf('/community-skins.css'),
    );
    expect(response.body.match(/community-skins\.css/g)).toHaveLength(1);
  });

  it.each([
    '/index.html',
    '/sessions/active',
    '/favicon.svg',
    '/assets/application-configuration.json',
  ])(
    'requires revalidation for %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-cache');
    },
  );
});

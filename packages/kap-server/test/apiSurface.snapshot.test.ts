import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

const META_ENDPOINTS = ['/openapi.json', '/asyncapi.json', '/'];

describe('API surface snapshot', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      try {
        await server.close();
      } catch {
      }
      server = undefined;
    }
    if (home !== undefined) {
      rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('matches the documented v2 route table and meta endpoints', async () => {
    home = mkdtempSync(join(tmpdir(), 'kimi-server-v2-api-surface-'));

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });

    const base = `http://${server.host}:${server.port}`;

    const openApiRes = await fetch(`${base}/openapi.json`, { headers: authHeaders(server) } as never);
    expect(openApiRes.status).toBe(200);
    const openApi = (await openApiRes.json()) as {
      paths?: Record<string, Record<string, unknown>>;
    };
    const paths = openApi.paths ?? {};
    expect(Object.keys(paths).length).toBeGreaterThan(0);

    const routes: Array<[string, string]> = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const key of Object.keys(item)) {
        if (HTTP_METHODS.has(key.toLowerCase())) {
          routes.push([key.toUpperCase(), path]);
        }
      }
    }
    routes.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

    const meta: Array<[string, string, number]> = [];
    for (const endpoint of META_ENDPOINTS) {
      const res = await fetch(`${base}${endpoint}`, { headers: authHeaders(server) } as never);
      meta.push(['GET', endpoint, res.status]);
    }
    meta.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);

    expect({ routes, meta }).toMatchSnapshot();
  });
});

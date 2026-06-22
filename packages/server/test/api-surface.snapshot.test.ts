/**
 * API surface snapshot guardrail (ROADMAP M0.1).
 *
 * Boots `startServer` on port 0 with a tmpdir lock + isolated home dir, then
 * records a stable, sorted snapshot of the documented API surface:
 *
 *   - `routes`: every `[METHOD, path]` pair derived from `/openapi.json`
 *     `paths` (the documented v1 REST surface). This is the guardrail's target:
 *     later phases that add / remove / hide routes show an intentional diff.
 *   - `meta`: the `(method, url, status)` of doc/meta endpoints that sit
 *     outside `paths` (`/healthz`, `/openapi.json`, `/asyncapi.json`, `/`).
 *     Status codes prove reachability.
 *
 * `startServer` does not expose the Fastify `app`, so the surface is read
 * through the public `/openapi.json` endpoint rather than by inspecting the
 * route table directly — keeping M0 a no-behavior-change phase.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src';
import { authHeaders, fixedTokenAuth } from './helpers/serverHarness';

/** OpenAPI path-item keys that are HTTP methods (skip `parameters`, etc.). */
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

/** Meta endpoints outside the OpenAPI `paths` map to probe for reachability. */
const META_ENDPOINTS = ['/healthz', '/openapi.json', '/asyncapi.json', '/'];

describe('API surface snapshot', () => {
  let tmpDir: string | undefined;
  let bridgeHome: string | undefined;
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      try {
        await server.close();
      } catch {
        // ignore — best-effort teardown
      }
      server = undefined;
    }
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    if (bridgeHome !== undefined) {
      rmSync(bridgeHome, { recursive: true, force: true });
      bridgeHome = undefined;
    }
  });

  it('matches the documented v1 route table and meta endpoints', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-api-surface-'));
    bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-api-surface-home-'));
    const lockPath = join(tmpDir, 'lock');

    server = await startServer({
      serviceOverrides: [fixedTokenAuth()],
      host: '127.0.0.1',
      port: 0,
      lockPath,
      logger: pino({ level: 'silent' }),
      coreProcessOptions: { homeDir: bridgeHome },
    });

    const address = server.address;

    // 1) Documented v1 REST surface, derived from /openapi.json `paths`.
    const openApiRes = await fetch(`${address}/openapi.json`, { headers: authHeaders() });
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

    // 2) Doc/meta endpoints that are not part of the OpenAPI `paths` map.
    const meta: Array<[string, string, number]> = [];
    for (const endpoint of META_ENDPOINTS) {
      const res = await fetch(`${address}${endpoint}`, { headers: authHeaders() });
      meta.push(['GET', endpoint, res.status]);
    }
    meta.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);

    expect({ routes, meta }).toMatchSnapshot();
  });
});

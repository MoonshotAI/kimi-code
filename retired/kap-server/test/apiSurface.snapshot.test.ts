/**
 * API surface snapshot guardrail (ported from v1 ROADMAP M0.1).
 *
 * Boots `startServer` on port 0 with an isolated home dir, then records a
 * stable, sorted snapshot of the documented API surface:
 *
 *   - `routes`: every `[METHOD, path]` pair derived from `/openapi.json`
 *     `paths` (the documented REST surface). This is the guardrail's target:
 *     route additions / removals / renames show an intentional diff.
 *   - `meta`: the `(method, url, status)` of doc/meta endpoints that sit
 *     outside `paths` (`/openapi.json`, `/asyncapi.json`, `/`). Status codes
 *     prove reachability (or, for `/`, the deliberate absence of a root
 *     handler).
 *
 * The surface is read through the public `/openapi.json` endpoint rather than
 * by inspecting Fastify's route table directly — keeping this a behavior-only
 * guardrail over the wire contract.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src';
import { authHeaders } from './helpers/auth';

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

/** Doc/meta endpoints outside the OpenAPI `paths` map to probe for reachability. */
const META_ENDPOINTS = ['/openapi.json', '/asyncapi.json', '/'];

describe('API surface snapshot', () => {
  let home: string | undefined;
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
    if (home !== undefined) {
      rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('matches the documented v2 route table and meta endpoints', async () => {
    home = mkdtempSync(join(tmpdir(), 'kimi-server-v2-api-surface-'));

    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });

    const base = `http://${server.host}:${server.port}`;

    // 1) Documented REST surface, derived from /openapi.json `paths`.
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

    // 2) Doc/meta endpoints that are not part of the OpenAPI `paths` map.
    const meta: Array<[string, string, number]> = [];
    for (const endpoint of META_ENDPOINTS) {
      const res = await fetch(`${base}${endpoint}`, { headers: authHeaders(server) } as never);
      meta.push(['GET', endpoint, res.status]);
    }
    meta.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);

    expect({ routes, meta }).toMatchSnapshot();
  });
});

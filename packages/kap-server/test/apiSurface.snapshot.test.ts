import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HOST_API_LEVEL, startServer, type RunningServer } from '../src';
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

  beforeAll(async () => {
    vi.stubEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START', '0');
    vi.stubEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS', '0');
    home = mkdtempSync(join(tmpdir(), 'kimi-server-v2-api-surface-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
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
    const base = `http://${server!.host}:${server!.port}`;

    const openApiRes = await fetch(`${base}/openapi.json`, { headers: authHeaders(server as RunningServer) } as never);
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
      const res = await fetch(`${base}${endpoint}`, { headers: authHeaders(server as RunningServer) } as never);
      meta.push(['GET', endpoint, res.status]);
    }
    meta.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);

    expect({ routes, meta }).toMatchSnapshot();
  });

  it('pins the host API level to the client-visible contract', async () => {
    const base = `http://${server!.host}:${server!.port}`;
    const fetchJson = async (path: string): Promise<Record<string, unknown>> => {
      const res = await fetch(`${base}${path}`, { headers: authHeaders(server as RunningServer) } as never);
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    const openApi = await fetchJson('/openapi.json');
    const asyncApi = await fetchJson('/asyncapi.json');
    const paths = Object.fromEntries(
      Object.entries(openApi['paths'] as Record<string, unknown>).filter(([path]) => !path.startsWith('/api/v1/debug')),
    );
    const contract = canonicalContract({
      paths,
      components: openApi['components'],
      operations: asyncApi['operations'],
      messages: asyncApi['components'],
    });
    const digest = createHash('sha256').update(contract).digest('hex');

    if (digest !== HOST_CONTRACT.digest) {
      const { inspect } = await import('node:util');
      console.error('CONTRACT_DEBUG', inspect({ paths, components: openApi['components'], operations: asyncApi['operations'], messages: asyncApi['components'] }, { depth: null, maxArrayLength: null }));
    }
    expect(
      { apiLevel: HOST_API_LEVEL, digest },
      'The client-visible API contract changed. If the current client would break against a remote running the previous release, bump HOST_API_LEVEL; then update HOST_CONTRACT to the new level and digest.',
    ).toEqual(HOST_CONTRACT);
  });
});

const HOST_CONTRACT = { apiLevel: 1, digest: '61020d19c731c91e8fd9c1c6d4bb1dcd873deb2e18421af03b705a8b04a3e4fb' };

const NON_CONTRACT_KEYS = new Set(['description', 'summary', 'example', 'examples']);
const NAMED_MEMBER_KEYS = new Set(['properties', 'patternProperties']);

function canonicalContract(value: unknown, namedMembers = false): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalContract(item)).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const entries = Object.entries(value)
    .filter(([key, item]) => (namedMembers || !NON_CONTRACT_KEYS.has(key)) && item !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalContract(item, !namedMembers && NAMED_MEMBER_KEYS.has(key))}`);
  return `{${entries.join(',')}}`;
}

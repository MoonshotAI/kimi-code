import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contractDigest, expectContractGolden } from '@moonshot-ai/testkit/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HOST_API_LEVEL, startServer, type RunningServer } from '../src';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const HOST_CONTRACT = { apiLevel: 1, digest: 'a7ff911859c7299a2dc466404dd68b554df1b46af1a9c11dceab0667497f6ff4' };

const DEBUG_ROUTES = [
  'GET /api/v1/debug/channels',
  'GET /api/v1/debug/session/{session_id}/agent/{agent_id}/environment-binding',
  'GET /api/v1/debug/session/{session_id}/agent/{agent_id}/{service}/{method}',
  'GET /api/v1/debug/session/{session_id}/association',
  'GET /api/v1/debug/session/{session_id}/{service}/{method}',
  'GET /api/v1/debug/workspace/{workspace_id}/snapshot',
  'GET /api/v1/debug/workspaces',
  'GET /api/v1/debug/{service}/{method}',
  'POST /api/v1/debug/session/{session_id}/agent/{agent_id}/{service}/{method}',
  'POST /api/v1/debug/session/{session_id}/{service}/{method}',
  'POST /api/v1/debug/{service}/{method}',
];

const DEBUG_PATH_PREFIX = '/api/v1/debug/';
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const schemaFile = (name: string): string => fileURLToPath(new URL(`../schema/${name}`, import.meta.url));

type ApiDocument = Readonly<Record<string, unknown>>;

interface Surface {
  readonly origin: string;
  readonly headers: Record<string, string>;
  readonly openapi: ApiDocument;
  readonly asyncapi: ApiDocument;
}

describe('KAP API surface', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let surface: Surface | undefined;

  beforeAll(async () => {
    vi.stubEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START', '0');
    vi.stubEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS', '0');
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-server-api-surface-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      serverVersion: '0.0.0-fixture',
      debugEndpoints: true,
    });
    const origin = `http://${server.host}:${server.port}`;
    const headers = authHeaders(server);
    surface = { origin, headers, openapi: await documentAt(origin, headers, '/openapi.json'), asyncapi: await documentAt(origin, headers, '/asyncapi.json') };
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    try {
      await server?.close();
    } finally {
      if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  const started = (): Surface => {
    if (surface === undefined) throw new Error('The KAP server did not start');
    return surface;
  };

  it('[L0:kap.api-contract] publishes the reviewed REST and WebSocket contracts', async () => {
    const { openapi, asyncapi } = started();
    await expectContractGolden(
      { openapi: schemaFile('openapi.json'), asyncapi: schemaFile('asyncapi.json'), summary: schemaFile('contract.txt') },
      { openapi: withoutDebugRoutes(openapi), asyncapi },
      { kind: 'schema', refreshCommand: 'pnpm qa:refresh schema' },
    );
  });

  it('pins the host API level to the reviewed contract', () => {
    const { openapi, asyncapi } = started();
    expect(
      { apiLevel: HOST_API_LEVEL, digest: contractDigest(withoutDebugRoutes(openapi), asyncapi) },
      'The client-visible API contract changed; review packages/kap-server/schema/contract.txt. If the current client would break against a remote running the previous release, bump HOST_API_LEVEL; then update HOST_CONTRACT to the new level and digest.',
    ).toEqual(HOST_CONTRACT);
  });

  it('lists the internal debug routes outside the reviewed contract', () => {
    expect(routesOf(started().openapi).filter((route) => route.includes(` ${DEBUG_PATH_PREFIX}`))).toEqual(DEBUG_ROUTES);
  });

  it('serves no page at the root', async () => {
    const { origin, headers } = started();
    expect((await fetch(`${origin}/`, { headers })).status).toBe(404);
  });
});

async function documentAt(origin: string, headers: Record<string, string>, path: string): Promise<ApiDocument> {
  const response = await fetch(`${origin}${path}`, { headers });
  expect(response.status, path).toBe(200);
  return (await response.json()) as ApiDocument;
}

function pathsOf(openapi: ApiDocument): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return (openapi['paths'] ?? {}) as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

function withoutDebugRoutes(openapi: ApiDocument): ApiDocument {
  return { ...openapi, paths: Object.fromEntries(Object.entries(pathsOf(openapi)).filter(([path]) => !path.startsWith(DEBUG_PATH_PREFIX))) };
}

function routesOf(openapi: ApiDocument): string[] {
  return Object.entries(pathsOf(openapi))
    .flatMap(([path, item]) => Object.keys(item).filter((key) => HTTP_METHODS.has(key)).map((method) => `${method.toUpperCase()} ${path}`))
    .toSorted();
}

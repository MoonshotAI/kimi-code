import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contractDigest, expectContractGolden } from '@moonshot-ai/testkit/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { KAP_VERSION, KIMI_AGENT_PROTOCOL_VERSION, startServer, type RunningServer } from '../src';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const KAP_CONTRACT = { kapVersion: 1, digest: 'd7e92821ec2af8a9284fd426879e139f4be9e3204cc95646a38e6c267f782d9a' };

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

  it('publishes the reviewed REST and WebSocket contracts', async () => {
    const { openapi, asyncapi } = started();
    await expectContractGolden(
      { openapi: schemaFile('openapi.json'), asyncapi: schemaFile('asyncapi.json'), summary: schemaFile('contract.txt') },
      { openapi: withoutDebugRoutes(openapi), asyncapi },
      { kind: 'schema', refreshCommand: 'pnpm qa:refresh schema' },
    );
  });

  it('pins KAP_VERSION to the reviewed contract and aligns its major with KIMI_AGENT_PROTOCOL_VERSION', () => {
    const { openapi, asyncapi } = started();
    expect(Number(KIMI_AGENT_PROTOCOL_VERSION.split('.')[0])).toBe(KAP_VERSION);
    expect(
      { kapVersion: KAP_VERSION, digest: contractDigest(withoutDebugRoutes(openapi), asyncapi) },
      'The client-visible API contract changed; review packages/kap-server/schema/contract.txt. If the client and remote host can no longer interoperate across releases, bump KAP_VERSION (and KIMI_AGENT_PROTOCOL_VERSION major); then update KAP_CONTRACT to the new version and digest.',
    ).toEqual(KAP_CONTRACT);
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

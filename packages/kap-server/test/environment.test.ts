import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  closeSessionById,
  ISessionIndex,
  IProjectInstanceManager,
} from '@moonshot-ai/agent-core-v2';
import { say } from '@moonshot-ai/testkit/model';
import { kapFixtures, type KapFixtures } from '@moonshot-ai/testkit/vitest';
import { afterAll, beforeAll, describe, expect, it, test as base } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

const require = createRequire(import.meta.url);

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface EnvironmentBindingWire {
  workspace_id: string;
  environment_id: string;
  environment_cwd?: string;
  cwd?: string;
}

interface EnvironmentEntryWire {
  environment_id: string;
  type: 'local' | 'ssh' | 'docker' | 'command';
  status: string;
  connect_error?: string;
}

interface EnvironmentsWire {
  environments: EnvironmentEntryWire[];
}

interface SessionWire {
  id: string;
  workspace_id: string;
  workspace_root?: string;
  environment_id: string;
  environment_cwd?: string;
}

function resolveTsxCli(): string {
  const packageJson = require.resolve('tsx/package.json');
  return join(dirname(packageJson), 'dist', 'cli.mjs');
}

function resolveExecServerFixture(): string {
  const packageJson = require.resolve('@moonshot-ai/agent-core-v2/package.json');
  return join(dirname(packageJson), 'test', 'remote', 'fixtures', 'exec-server-child.ts');
}

function resolveMcpServerFixture(): string {
  const packageJson = require.resolve('@moonshot-ai/agent-core-v2/package.json');
  return join(dirname(packageJson), 'test', 'mcpCore', 'fixtures', 'mock-stdio-server.mjs');
}

function configToml(): string {
  const node = process.execPath;
  const tsx = resolveTsxCli();
  const fixture = resolveExecServerFixture();
  return [
    '[environments.loop]',
    `command = ${JSON.stringify(node)}`,
    `args = ${JSON.stringify([tsx, fixture])}`,
    'env = { EXEC_SERVER_VERSION = "9.9.9-test" }',
    'defaultCwd = "/tmp"',
    '',
  ].join('\n');
}

describe('server-v2 /api/v1 environment routes', () => {
  describe('with a loopback command environment', () => {
    let server: RunningServer | undefined;
    let home: string | undefined;
    let base: string;

    beforeAll(async () => {
      home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-environment-on-'));
      await writeFile(join(home, 'config.toml'), configToml(), 'utf-8');
      process.env['KIMI_CODE_WATCH'] = '1';
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      base = `http://127.0.0.1:${server.port}`;
    });

    afterAll(async () => {
      if (server !== undefined) {
        await server.close();
        server = undefined;
      }
      delete process.env['KIMI_CODE_WATCH'];
      if (home !== undefined) {
        await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        home = undefined;
      }
    });

    async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: Envelope<T> }> {
      const hasBody = body !== undefined;
      const res = await fetch(`${base}${path}`, {
        method,
        headers: authHeaders(server as RunningServer, hasBody ? { 'content-type': 'application/json' } : {}),
        body: hasBody ? JSON.stringify(body) : undefined,
      } as never);
      return { status: res.status, body: (await res.json()) as Envelope<T> };
    }

    async function createSession(): Promise<string> {
      const created = await call<SessionWire>('POST', '/api/v1/sessions', { metadata: { cwd: home as string } });
      expect(created.body.code).toBe(0);
      return created.body.data.id;
    }

    it('serves the local binding surface by default', async () => {
      const id = await createSession();

      const binding = await call<EnvironmentBindingWire>('GET', `/api/v1/sessions/${id}/environment`);
      expect(binding.body.code).toBe(0);
      expect(binding.body.data.environment_id).toBe('local');
      expect(binding.body.data.environment_cwd).toBeUndefined();
      expect(binding.body.data.cwd).toBeUndefined();

      const summary = await server!.core.accessor.get(ISessionIndex).get(id);
      await closeSessionById(server!.core.accessor, id);
      const wirePath = join(home as string, 'sessions', summary!.workspaceId, id, 'agents', 'main', 'wire.jsonl');
      const sourceWire = await readFile(wirePath, 'utf-8');
      expect(sourceWire).toContain('"min_protocol_version":"1.5"');
      await writeFile(
        wirePath,
        sourceWire
          .replace('"protocol_version":"1.5"', '"protocol_version":"9.9"')
          .replace('"min_protocol_version":"1.5"', '"min_protocol_version":"9.9"'),
        'utf-8',
      );
      const incompatible = await call<null>('GET', `/api/v1/sessions/${id}/environment`);
      expect(incompatible.body.code).toBe(40930);
      expect(incompatible.body.msg).toContain('Upgrade Kimi Code');
      const incompatibleList = await call<null>('GET', `/api/v1/sessions/${id}/environments`);
      expect(incompatibleList.body.code).toBe(40930);
      expect(incompatibleList.body.msg).toContain('Upgrade Kimi Code');
    });

    it('creates a session bound to a declared environment via POST /sessions', async () => {
      const created = await call<SessionWire>('POST', '/api/v1/sessions', {
        metadata: { cwd: home as string },
        environment_id: 'loop',
      });
      expect(created.body.code).toBe(0);
      expect(created.body.data).toMatchObject({
        workspace_root: home,
        environment_id: 'loop',
        environment_cwd: '/tmp',
      });
      const id = created.body.data.id;

      const binding = await call<EnvironmentBindingWire>('GET', `/api/v1/sessions/${id}/environment`);
      expect(binding.body.code).toBe(0);
      expect(binding.body.data).toMatchObject({ environment_id: 'loop', environment_cwd: '/tmp', cwd: '/tmp' });

      const withCwd = await call<SessionWire>('POST', '/api/v1/sessions', {
        metadata: { cwd: home as string },
        environment_id: 'loop',
        environment_cwd: '/tmp',
      });
      expect(withCwd.body.code).toBe(0);
      const withCwdBinding = await call<EnvironmentBindingWire>(
        'GET',
        `/api/v1/sessions/${withCwd.body.data.id}/environment`,
      );
      expect(withCwdBinding.body.data).toMatchObject({ environment_id: 'loop', cwd: '/tmp' });
    }, 90_000);

    it('rejects session creation with an undeclared environment or a lone environment_cwd', async () => {
      const ghost = await call<null>('POST', '/api/v1/sessions', {
        metadata: { cwd: home as string },
        environment_id: 'ghost',
      });
      expect(ghost.body.code).toBe(40001);
      expect(ghost.body.msg).toContain('ghost');

      const cwdOnly = await call<null>('POST', '/api/v1/sessions', {
        metadata: { cwd: home as string },
        environment_cwd: '/tmp',
      });
      expect(cwdOnly.body.code).toBe(40001);
      expect(cwdOnly.body.msg).toContain('environment_cwd');
    });
  });
});

const kapTest = base.extend<KapFixtures<RunningServer>>(kapFixtures({
  startServer,
  config: {
    extra: {
      environments: {
        slow: {
          command: '/bin/sh',
          args: ['-c', 'sleep 1; exec "$@"', 'sh', process.execPath, resolveTsxCli(), resolveExecServerFixture()],
          env: { EXEC_SERVER_VERSION: '9.9.9-test' },
        },
      },
    },
  },
}));

kapTest('offers the MCP tools of the project in the first request of a session whose environment connects slower than the servers start', { timeout: 60_000 }, async ({ kap, model }) => {
  await writeFile(join(kap.home.dataDir, 'mcp.json'), JSON.stringify({
    mcpServers: { slow: { command: process.execPath, args: [resolveMcpServerFixture()], env: { KIMI_TEST_MCP_START_DELAY_MS: '300' } } },
  }));
  model.script(say('done'));
  const session = await kap.rest.post<SessionWire>('/api/v1/sessions', {
    cwd: kap.home.workspace,
    environment_id: 'slow',
    environment_cwd: kap.home.workspace,
  });
  await kap.prompt(session.id, 'hi');
  await kap.waitIdle(session.id);

  expect(model.requests()[0]!.tools).toContain('mcp__slow__echo');
});

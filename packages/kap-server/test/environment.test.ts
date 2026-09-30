import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ISessionContext,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
}

function resolveTsxCli(): string {
  const packageJson = require.resolve('tsx/package.json');
  return join(dirname(packageJson), 'dist', 'cli.mjs');
}

function resolveExecServerFixture(): string {
  const packageJson = require.resolve('@moonshot-ai/agent-core-v2/package.json');
  return join(dirname(packageJson), 'test', 'remote', 'fixtures', 'exec-server-child.ts');
}

const DYING_SCRIPT = 'process.stderr.write("kimi: command not found\\n"); process.exit(127)';

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
    '[environments.dying]',
    `command = ${JSON.stringify(node)}`,
    `args = ${JSON.stringify(['-e', DYING_SCRIPT])}`,
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
      expect(binding.body.data.cwd).toBeUndefined();
    });

    it('returns 40401 without a stack for an unknown session on every environment route', async () => {
      const ghost = '/api/v1/sessions/s_does_not_exist';
      const responses = await Promise.all([
        call<null>('GET', `${ghost}/environment`),
        call<null>('GET', `${ghost}/environments`),
      ]);
      for (const res of responses) {
        expect(res.body.code).toBe(40401);
        expect(res.body.msg).toContain('s_does_not_exist');
        expect((res.body as { stack?: string }).stack).toBeUndefined();
      }
    });

    it('lists app environments after the session workspace closes', async () => {
      const id = await createSession();
      const session = getLiveSessionById(server!.core.accessor, id);
      const workspaceId = session!.accessor.get(ISessionContext).workspaceId;
      await server!.core.accessor.get(IWorkspaceInstanceManager).close(workspaceId);
      await server!.core.accessor.get(IWorkspaceService).delete(workspaceId);

      const listed = await call<null>('GET', `/api/v1/sessions/${id}/environments`);
      expect(listed.body.code).toBe(0);
      expect((listed.body as { stack?: string }).stack).toBeUndefined();
    });

    it('lists declared environments as pending placeholders before any connect', async () => {
      const id = await createSession();
      const environments = await call<EnvironmentsWire>('GET', `/api/v1/sessions/${id}/environments`);
      expect(environments.body.code).toBe(0);
      const byId = new Map(environments.body.data.environments.map((entry) => [entry.environment_id, entry]));
      expect(byId.get('local')).toMatchObject({ type: 'local', status: 'ready' });
      expect(byId.get('loop')).toMatchObject({ type: 'command', status: 'pending' });
      expect(byId.get('dying')).toMatchObject({ type: 'command', status: 'pending' });
      expect(byId.get('loop')?.connect_error).toBeUndefined();
    });

    it('creates a session bound to a declared environment via POST /sessions', async () => {
      const created = await call<SessionWire>('POST', '/api/v1/sessions', {
        metadata: { cwd: home as string },
        environment_id: 'loop',
      });
      expect(created.body.code).toBe(0);
      const id = created.body.data.id;

      const binding = await call<EnvironmentBindingWire>('GET', `/api/v1/sessions/${id}/environment`);
      expect(binding.body.code).toBe(0);
      expect(binding.body.data).toMatchObject({ environment_id: 'loop', cwd: '/tmp' });

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

    it('fails session creation loudly when the environment cannot connect', async () => {
      const created = await call<null>('POST', '/api/v1/sessions', {
        metadata: { cwd: home as string },
        environment_id: 'dying',
      });
      expect(created.body.code).toBe(40926);
    }, 90_000);

    it('surfaces the connect failure reason as connect_error in the environment list', async () => {
      const created = await call<null>('POST', '/api/v1/sessions', {
        metadata: { cwd: home as string },
        environment_id: 'dying',
        environment_cwd: '/tmp',
      });
      expect(created.body.code).toBe(40926);

      const id = await createSession();
      const environments = await call<EnvironmentsWire>('GET', `/api/v1/sessions/${id}/environments`);
      const entry = environments.body.data.environments.find((candidate) => candidate.environment_id === 'dying');
      expect(entry?.status).toBe('disconnected');
      expect(entry?.connect_error).toContain('code 127');
      expect(entry?.connect_error).toContain('kimi: command not found');
    }, 90_000);

    it('rejects a missing workspace root for a local binding but defers it for a remote binding', async () => {
      const missingRoot = join(home as string, 'never-created');
      const local = await call<null>('POST', '/api/v1/sessions', { metadata: { cwd: missingRoot } });
      expect(local.body.code).toBe(40409);
      expect(local.body.msg).toContain(missingRoot);

      const remote = await call<SessionWire>('POST', '/api/v1/sessions', {
        metadata: { cwd: missingRoot },
        environment_id: 'loop',
      });
      expect(remote.body.code).toBe(0);

      const bound = await call<null>('POST', '/api/v1/sessions', {
        metadata: { cwd: home as string },
        environment_id: 'loop',
        environment_cwd: missingRoot,
      });
      expect(bound.body.code).toBe(40001);
      expect(bound.body.msg).toContain(missingRoot);

      const binding = await call<EnvironmentBindingWire>(
        'GET',
        `/api/v1/sessions/${remote.body.data.id}/environment`,
      );
      expect(binding.body.data.environment_id).toBe('loop');
    }, 90_000);
  });
});

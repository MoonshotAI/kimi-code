import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { IWorkspaceInstanceManager } from '@moonshot-ai/agent-core-v2';
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
      expect(binding.body.data.cwd).toBeUndefined();
    });

    it('lists project-only environments only in the trusted originating workspace', async () => {
      const rootA = join(home!, 'project-a');
      const rootB = join(home!, 'project-b');
      await mkdir(join(rootA, '.kimi-code'), { recursive: true });
      await mkdir(rootB);
      await writeFile(join(rootA, '.kimi-code', 'environments.toml'), '[project-box]\ncommand = "example-launcher"\ndefaultCwd = "/remote/project"');
      const workspace = await server!.core.accessor.get(IWorkspaceInstanceManager).getOrCreate({ root: rootA });
      await workspace.program.trust.trust();
      const a = await call<SessionWire>('POST', '/api/v1/sessions', { metadata: { cwd: rootA } });
      const b = await call<SessionWire>('POST', '/api/v1/sessions', { metadata: { cwd: rootB } });
      expect(a.body.code).toBe(0);
      expect(b.body.code).toBe(0);
      const listA = await call<EnvironmentsWire>('GET', `/api/v1/sessions/${a.body.data.id}/environments`);
      const listB = await call<EnvironmentsWire>('GET', `/api/v1/sessions/${b.body.data.id}/environments`);
      expect(listA.body.data.environments).toContainEqual(expect.objectContaining({ environment_id: 'project-box', status: 'pending' }));
      expect(listB.body.data.environments.some((entry) => entry.environment_id === 'project-box')).toBe(false);
      const denied = await call<SessionWire>('POST', '/api/v1/sessions', { metadata: { cwd: rootB }, environment_id: 'project-box', environment_cwd: '/remote/project' });
      expect(denied.body.code).not.toBe(0);
    });

    it('keeps legacy runtime routes on the same binding', async () => {
      const id = await createSession();
      const initial = await call<{ workspace_id: string; runtime_id: string }>(
        'GET',
        `/api/v1/sessions/${id}/runtime`,
      );
      expect(initial.body.code).toBe(0);
      expect(initial.body.data.runtime_id).toBe('local');

      const switched = await call<{ workspace_id: string; runtime_id: string }>(
        'POST',
        `/api/v1/sessions/${id}/runtime`,
        { runtime_id: 'loop' },
      );
      expect(switched.body.code).toBe(0);
      expect(switched.body.data).toEqual({
        workspace_id: initial.body.data.workspace_id,
        runtime_id: 'loop',
      });

      const binding = await call<EnvironmentBindingWire>('GET', `/api/v1/sessions/${id}/environment`);
      expect(binding.body.data.environment_id).toBe('loop');
    }, 90_000);

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
  });
});

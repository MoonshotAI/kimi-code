import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ISessionContext,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
  generation: string;
  capabilities: string[];
  default_cwd?: string;
  connect_error?: string;
}

interface EnvironmentsWire {
  workspace_id: string;
  environments: EnvironmentEntryWire[];
  ssh_hosts: string[];
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
  const packageJson = require.resolve('@moonshot-ai/remote-exec/package.json');
  return join(dirname(packageJson), 'test', 'fixtures', 'exec-server-child.ts');
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

      const switched = await call<EnvironmentBindingWire>('POST', `/api/v1/sessions/${id}/environment`, { environment_id: 'local' });
      expect(switched.body.code).toBe(0);
      expect(switched.body.data.environment_id).toBe('local');

      const missing = await call<null>('POST', `/api/v1/sessions/${id}/environment`, { environment_id: 'ghost' });
      expect(missing.body.code).toBe(40001);
    });

    it('returns 40401 without a stack for an unknown session on every environment route', async () => {
      const ghost = '/api/v1/sessions/s_does_not_exist';
      const responses = await Promise.all([
        call<null>('GET', `${ghost}/environment`),
        call<null>('GET', `${ghost}/environments`),
        call<null>('POST', `${ghost}/environment`, { environment_id: 'local' }),
        call<null>('POST', `${ghost}/environment/reconnect`),
        call<null>('POST', `${ghost}/environments`, {
          environment_id: 'box',
          entry: { type: 'ssh', host: 'box' },
        }),
      ]);
      for (const res of responses) {
        expect(res.body.code).toBe(40401);
        expect(res.body.msg).toContain('s_does_not_exist');
        expect((res.body as { stack?: string }).stack).toBeUndefined();
      }
    });

    it('returns 40410 when the session workspace no longer exists', async () => {
      const id = await createSession();
      const session = getLiveSessionById(server!.core.accessor, id);
      const workspaceId = session!.accessor.get(ISessionContext).workspaceId;
      await server!.core.accessor.get(IWorkspaceInstanceManager).close(workspaceId);
      await server!.core.accessor.get(IWorkspaceService).delete(workspaceId);

      const listed = await call<null>('GET', `/api/v1/sessions/${id}/environments`);
      expect(listed.body.code).toBe(40410);
      expect(listed.body.msg).toContain(workspaceId);
      expect((listed.body as { stack?: string }).stack).toBeUndefined();
    });

    it('lists declared environments as pending placeholders before any connect', async () => {
      const id = await createSession();
      const environments = await call<EnvironmentsWire>('GET', `/api/v1/sessions/${id}/environments`);
      expect(environments.body.code).toBe(0);
      const byId = new Map(environments.body.data.environments.map((entry) => [entry.environment_id, entry]));
      expect(byId.get('local')).toMatchObject({ type: 'local', status: 'ready' });
      expect(byId.get('loop')).toMatchObject({ type: 'command', status: 'pending', default_cwd: '/tmp' });
      expect(byId.get('dying')).toMatchObject({ type: 'command', status: 'pending', default_cwd: '/tmp' });
      expect(byId.get('loop')?.connect_error).toBeUndefined();
      expect(Array.isArray(environments.body.data.ssh_hosts)).toBe(true);
    });

    it('switches with connectAndSwitch, validates the remote cwd, and reconnects explicitly', async () => {
      const id = await createSession();

      const switched = await call<EnvironmentBindingWire>('POST', `/api/v1/sessions/${id}/environment`, {
        environment_id: 'loop',
        cwd: '/tmp',
      }, );
      expect(switched.body.code).toBe(0);
      expect(switched.body.data).toMatchObject({ environment_id: 'loop', cwd: '/tmp' });

      const binding = await call<EnvironmentBindingWire>('GET', `/api/v1/sessions/${id}/environment`);
      expect(binding.body.data).toMatchObject({ environment_id: 'loop', cwd: '/tmp' });

      const connected = await call<EnvironmentsWire>('GET', `/api/v1/sessions/${id}/environments`);
      expect(connected.body.data.environments.find((entry) => entry.environment_id === 'loop')?.status).toBe('ready');

      const invalidCwd = await call<null>('POST', `/api/v1/sessions/${id}/environment`, {
        environment_id: 'loop',
        cwd: '/definitely-not-a-directory-xyz',
      });
      expect(invalidCwd.body.code).toBe(40001);
      expect(invalidCwd.body.msg).toContain('/definitely-not-a-directory-xyz');

      const stillBound = await call<EnvironmentBindingWire>('GET', `/api/v1/sessions/${id}/environment`);
      expect(stillBound.body.data).toMatchObject({ environment_id: 'loop', cwd: '/tmp' });

      const dying = await call<null>('POST', `/api/v1/sessions/${id}/environment`, {
        environment_id: 'dying',
        cwd: '/tmp',
      });
      expect(dying.body.code).toBe(40926);
      expect(dying.body.msg).toContain('code 127');
      expect(dying.body.msg).toContain('kimi: command not found');

      const reconnected = await call<EnvironmentBindingWire>('POST', `/api/v1/sessions/${id}/environment/reconnect`);
      expect(reconnected.body.code).toBe(0);
      expect(reconnected.body.data).toMatchObject({ environment_id: 'loop', cwd: '/tmp' });

      const backToLocal = await call<EnvironmentBindingWire>('POST', `/api/v1/sessions/${id}/environment`, {
        environment_id: 'local',
      });
      expect(backToLocal.body.code).toBe(0);
      expect(backToLocal.body.data.environment_id).toBe('local');

      const localReconnect = await call<null>('POST', `/api/v1/sessions/${id}/environment/reconnect`);
      expect(localReconnect.body.code).toBe(40926);
      expect(localReconnect.body.msg).toContain('does not support reconnect');

      const missing = await call<null>('POST', `/api/v1/sessions/${id}/environment`, {
        environment_id: 'ghost',
        cwd: '/tmp',
      });
      expect(missing.body.code).toBe(40420);
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

    it('fails session creation loudly when the environment cannot connect', async () => {
      const created = await call<null>('POST', '/api/v1/sessions', {
        metadata: { cwd: home as string },
        environment_id: 'dying',
      });
      expect(created.body.code).toBe(40926);
    }, 90_000);

    it('surfaces the connect failure reason as connect_error in the environment list', async () => {
      const id = await createSession();

      const dying = await call<null>('POST', `/api/v1/sessions/${id}/environment`, {
        environment_id: 'dying',
        cwd: '/tmp',
      });
      expect(dying.body.code).toBe(40926);

      const environments = await call<EnvironmentsWire>('GET', `/api/v1/sessions/${id}/environments`);
      const entry = environments.body.data.environments.find((candidate) => candidate.environment_id === 'dying');
      expect(entry?.status).toBe('disconnected');
      expect(entry?.connect_error).toContain('code 127');
      expect(entry?.connect_error).toContain('kimi: command not found');
    }, 30_000);

    it('defers workspace root validation to the first environment binding', async () => {
      const missingRoot = join(home as string, 'never-created');
      const created = await call<SessionWire>('POST', '/api/v1/sessions', { metadata: { cwd: missingRoot } });
      expect(created.body.code).toBe(0);
      const id = created.body.data.id;

      const bound = await call<null>('POST', `/api/v1/sessions/${id}/environment`, {
        environment_id: 'loop',
        cwd: missingRoot,
      });
      expect(bound.body.code).toBe(40001);
      expect(bound.body.msg).toContain(missingRoot);

      const binding = await call<EnvironmentBindingWire>('GET', `/api/v1/sessions/${id}/environment`);
      expect(binding.body.data.environment_id).toBe('local');
    }, 90_000);

    interface DeclaredWire {
      workspace_id: string;
      environment_id: string;
      scope: 'global' | 'project';
    }

    async function createSessionWire(cwd: string = home as string): Promise<SessionWire> {
      const created = await call<SessionWire>('POST', '/api/v1/sessions', { metadata: { cwd } });
      expect(created.body.code).toBe(0);
      return created.body.data;
    }

    it('declares an environment at global scope into config.toml and registers it live', async () => {
      const { id } = await createSessionWire();
      const declared = await call<DeclaredWire>('POST', `/api/v1/sessions/${id}/environments`, {
        environment_id: 'rest-box',
        entry: { type: 'ssh', host: 'rest-box', default_cwd: '/remote/rest' },
      });
      expect(declared.body.code).toBe(0);
      expect(declared.body.data).toMatchObject({ environment_id: 'rest-box', scope: 'global' });
      const toml = await readFile(join(home as string, 'config.toml'), 'utf-8');
      expect(toml).toContain('[environments.rest-box]');
      expect(toml).toContain('defaultCwd = "/remote/rest"');
      await vi.waitFor(
        async () => {
          const environments = await call<EnvironmentsWire>('GET', `/api/v1/sessions/${id}/environments`);
          expect(environments.body.data.environments.some((entry) => entry.environment_id === 'rest-box')).toBe(true);
        },
        { timeout: 10_000, interval: 100 },
      );
    });

    it('rejects a duplicate global declare, leaving config.toml untouched', async () => {
      const { id } = await createSessionWire();
      const first = await call<DeclaredWire>('POST', `/api/v1/sessions/${id}/environments`, {
        environment_id: 'rest-dup-box',
        entry: { type: 'ssh', host: 'rest-dup-box', default_cwd: '/remote/rest' },
      });
      expect(first.body.code).toBe(0);
      const before = await readFile(join(home as string, 'config.toml'), 'utf-8');
      expect(before).toContain('[environments.rest-dup-box]');

      const duplicate = await call<null>('POST', `/api/v1/sessions/${id}/environments`, {
        environment_id: 'rest-dup-box',
        entry: { type: 'ssh', host: 'other-box' },
      });
      expect(duplicate.body.code).toBe(40001);
      expect(duplicate.body.msg).toContain('already declared');
      expect(await readFile(join(home as string, 'config.toml'), 'utf-8')).toBe(before);
    });

    it('declares an environment at project scope into .kimi-code/environments.toml without clobbering it', async () => {
      const session = await createSessionWire();
      await mkdir(join(home as string, '.kimi-code'), { recursive: true });
      await writeFile(
        join(home as string, '.kimi-code', 'environments.toml'),
        ['# Team-shared declarations.', '[existing-box]', 'type = "ssh"', 'host = "existing-box"', ''].join('\n'),
        'utf-8',
      );
      const trusted = await call('POST', `/api/v1/workspaces/${session.workspace_id}/trust`);
      expect(trusted.body.code).toBe(0);

      const declared = await call<DeclaredWire>('POST', `/api/v1/sessions/${session.id}/environments`, {
        environment_id: 'proj-box',
        scope: 'project',
        entry: { type: 'ssh', host: 'proj-box', default_cwd: '/remote/proj' },
      });
      expect(declared.body.code).toBe(0);
      expect(declared.body.data).toMatchObject({ environment_id: 'proj-box', scope: 'project' });

      const toml = await readFile(join(home as string, '.kimi-code', 'environments.toml'), 'utf-8');
      expect(toml).toContain('# Team-shared declarations.');
      expect(toml).toContain('[existing-box]');
      expect(toml).toContain('[proj-box]');

      await vi.waitFor(
        async () => {
          const environments = await call<EnvironmentsWire>('GET', `/api/v1/sessions/${session.id}/environments`);
          const projBox = environments.body.data.environments.find((entry) => entry.environment_id === 'proj-box');
          expect(projBox).toMatchObject({ type: 'ssh', default_cwd: '/remote/proj' });
        },
        { timeout: 10_000, interval: 100 },
      );
    });

    it('rejects a duplicate project declare and an invalid entry payload', async () => {
      const wsDir = join(home as string, 'dup-ws');
      await mkdir(wsDir, { recursive: true });
      const session = await createSessionWire(wsDir);
      const trusted = await call('POST', `/api/v1/workspaces/${session.workspace_id}/trust`);
      expect(trusted.body.code).toBe(0);
      const first = await call<DeclaredWire>('POST', `/api/v1/sessions/${session.id}/environments`, {
        environment_id: 'proj-box',
        scope: 'project',
        entry: { type: 'ssh', host: 'proj-box' },
      });
      expect(first.body.code).toBe(0);
      const duplicate = await call<null>('POST', `/api/v1/sessions/${session.id}/environments`, {
        environment_id: 'proj-box',
        scope: 'project',
        entry: { type: 'ssh', host: 'other-box' },
      });
      expect(duplicate.body.code).toBe(40001);
      expect(duplicate.body.msg).toContain('already declared');

      const invalid = await call<null>('POST', `/api/v1/sessions/${session.id}/environments`, {
        environment_id: 'no-host',
        entry: { type: 'ssh' },
      });
      expect(invalid.body.code).toBe(40001);
    });

    it('rejects a project declare while the workspace is untrusted', async () => {
      const wsDir = join(home as string, 'untrusted-ws');
      await mkdir(wsDir, { recursive: true });
      const session = await createSessionWire(wsDir);
      const declared = await call<null>('POST', `/api/v1/sessions/${session.id}/environments`, {
        environment_id: 'proj-box',
        scope: 'project',
        entry: { type: 'ssh', host: 'proj-box' },
      });
      expect(declared.body.code).toBe(40001);
      expect(declared.body.msg).toContain('not trusted');
      expect(await readFile(join(wsDir, '.kimi-code', 'environments.toml'), 'utf-8').catch(() => undefined)).toBeUndefined();

      const trusted = await call('POST', `/api/v1/workspaces/${session.workspace_id}/trust`);
      expect(trusted.body.code).toBe(0);
      const afterTrust = await call<DeclaredWire>('POST', `/api/v1/sessions/${session.id}/environments`, {
        environment_id: 'proj-box',
        scope: 'project',
        entry: { type: 'ssh', host: 'proj-box' },
      });
      expect(afterTrust.body.code).toBe(0);
    });
  });
});

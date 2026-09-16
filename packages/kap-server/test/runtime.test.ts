import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

interface RuntimeBindingWire {
  workspace_id: string;
  runtime_id: string;
  cwd?: string;
}

interface RuntimeEntryWire {
  runtime_id: string;
  type: 'local' | 'ssh' | 'docker' | 'command';
  status: string;
  generation: string;
  capabilities: string[];
  default_cwd?: string;
}

interface RuntimesWire {
  workspace_id: string;
  runtimes: RuntimeEntryWire[];
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
    '[experimental]',
    'remote_runtime = true',
    '',
    '[runtimes.loop]',
    `command = ${JSON.stringify(node)}`,
    `args = ${JSON.stringify([tsx, fixture])}`,
    'env = { EXEC_SERVER_VERSION = "9.9.9-test" }',
    'defaultCwd = "/tmp"',
    '',
    '[runtimes.dying]',
    `command = ${JSON.stringify(node)}`,
    `args = ${JSON.stringify(['-e', DYING_SCRIPT])}`,
    'defaultCwd = "/tmp"',
    '',
  ].join('\n');
}

describe('server-v2 /api/v1 runtime routes', () => {
  describe('with the remote_runtime flag off', () => {
    let server: RunningServer | undefined;
    let home: string | undefined;
    let base: string;

    beforeAll(async () => {
      home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-runtime-off-'));
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

    it('keeps the legacy surface: local binding, sync switch, no new endpoint behavior', async () => {
      const id = await createSession();

      const binding = await call<RuntimeBindingWire>('GET', `/api/v1/sessions/${id}/runtime`);
      expect(binding.body.code).toBe(0);
      expect(binding.body.data.runtime_id).toBe('local');
      expect(binding.body.data.cwd).toBeUndefined();

      const switched = await call<RuntimeBindingWire>('POST', `/api/v1/sessions/${id}/runtime`, { runtime_id: 'local' });
      expect(switched.body.code).toBe(0);
      expect(switched.body.data.runtime_id).toBe('local');

      const ignoredCwd = await call<RuntimeBindingWire>('POST', `/api/v1/sessions/${id}/runtime`, {
        runtime_id: 'local',
        cwd: '/tmp',
      });
      expect(ignoredCwd.body.code).toBe(0);
      expect(ignoredCwd.body.data.cwd).toBeUndefined();

      const missing = await call<null>('POST', `/api/v1/sessions/${id}/runtime`, { runtime_id: 'ghost' });
      expect(missing.body.code).toBe(40420);

      const reconnect = await call<null>('POST', `/api/v1/sessions/${id}/runtime/reconnect`);
      expect(reconnect.body.code).toBe(40926);
      expect(reconnect.body.msg).toContain('remote_runtime');

      const runtimes = await call<RuntimesWire>('GET', `/api/v1/sessions/${id}/runtimes`);
      expect(runtimes.body.code).toBe(0);
      expect(runtimes.body.data.runtimes).toHaveLength(1);
      expect(runtimes.body.data.runtimes[0]).toMatchObject({ runtime_id: 'local', type: 'local', status: 'ready' });
      expect(runtimes.body.data.ssh_hosts).toEqual([]);
    });
  });

  describe('with the remote_runtime flag on and a loopback command runtime', () => {
    let server: RunningServer | undefined;
    let home: string | undefined;
    let base: string;

    beforeAll(async () => {
      home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-runtime-on-'));
      await writeFile(join(home, 'config.toml'), configToml(), 'utf-8');
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

    it('lists declared runtimes as disconnected placeholders before any connect', async () => {
      const id = await createSession();
      const runtimes = await call<RuntimesWire>('GET', `/api/v1/sessions/${id}/runtimes`);
      expect(runtimes.body.code).toBe(0);
      const byId = new Map(runtimes.body.data.runtimes.map((entry) => [entry.runtime_id, entry]));
      expect(byId.get('local')).toMatchObject({ type: 'local', status: 'ready' });
      expect(byId.get('loop')).toMatchObject({ type: 'command', status: 'disconnected', default_cwd: '/tmp' });
      expect(byId.get('dying')).toMatchObject({ type: 'command', status: 'disconnected', default_cwd: '/tmp' });
      expect(Array.isArray(runtimes.body.data.ssh_hosts)).toBe(true);
    });

    it('switches with connectAndSwitch, validates the remote cwd, and reconnects explicitly', async () => {
      const id = await createSession();

      const switched = await call<RuntimeBindingWire>('POST', `/api/v1/sessions/${id}/runtime`, {
        runtime_id: 'loop',
        cwd: '/tmp',
      }, );
      expect(switched.body.code).toBe(0);
      expect(switched.body.data).toMatchObject({ runtime_id: 'loop', cwd: '/tmp' });

      const binding = await call<RuntimeBindingWire>('GET', `/api/v1/sessions/${id}/runtime`);
      expect(binding.body.data).toMatchObject({ runtime_id: 'loop', cwd: '/tmp' });

      const connected = await call<RuntimesWire>('GET', `/api/v1/sessions/${id}/runtimes`);
      expect(connected.body.data.runtimes.find((entry) => entry.runtime_id === 'loop')?.status).toBe('ready');

      const invalidCwd = await call<null>('POST', `/api/v1/sessions/${id}/runtime`, {
        runtime_id: 'loop',
        cwd: '/definitely-not-a-directory-xyz',
      });
      expect(invalidCwd.body.code).toBe(40001);
      expect(invalidCwd.body.msg).toContain('/definitely-not-a-directory-xyz');

      const stillBound = await call<RuntimeBindingWire>('GET', `/api/v1/sessions/${id}/runtime`);
      expect(stillBound.body.data).toMatchObject({ runtime_id: 'loop', cwd: '/tmp' });

      const dying = await call<null>('POST', `/api/v1/sessions/${id}/runtime`, {
        runtime_id: 'dying',
        cwd: '/tmp',
      });
      expect(dying.body.code).toBe(40926);
      expect(dying.body.msg).toContain('code 127');
      expect(dying.body.msg).toContain('kimi: command not found');

      const reconnected = await call<RuntimeBindingWire>('POST', `/api/v1/sessions/${id}/runtime/reconnect`);
      expect(reconnected.body.code).toBe(0);
      expect(reconnected.body.data).toMatchObject({ runtime_id: 'loop', cwd: '/tmp' });

      const backToLocal = await call<RuntimeBindingWire>('POST', `/api/v1/sessions/${id}/runtime`, {
        runtime_id: 'local',
      });
      expect(backToLocal.body.code).toBe(0);
      expect(backToLocal.body.data.runtime_id).toBe('local');

      const localReconnect = await call<null>('POST', `/api/v1/sessions/${id}/runtime/reconnect`);
      expect(localReconnect.body.code).toBe(40926);
      expect(localReconnect.body.msg).toContain('does not support reconnect');

      const missing = await call<null>('POST', `/api/v1/sessions/${id}/runtime`, {
        runtime_id: 'ghost',
        cwd: '/tmp',
      });
      expect(missing.body.code).toBe(40420);
    }, 90_000);

    it('defers workspace root validation to the first runtime binding', async () => {
      const missingRoot = join(home as string, 'never-created');
      const created = await call<SessionWire>('POST', '/api/v1/sessions', { metadata: { cwd: missingRoot } });
      expect(created.body.code).toBe(0);
      const id = created.body.data.id;

      const bound = await call<null>('POST', `/api/v1/sessions/${id}/runtime`, {
        runtime_id: 'loop',
        cwd: missingRoot,
      });
      expect(bound.body.code).toBe(40001);
      expect(bound.body.msg).toContain(missingRoot);

      const binding = await call<RuntimeBindingWire>('GET', `/api/v1/sessions/${id}/runtime`);
      expect(binding.body.data.runtime_id).toBe('local');
    }, 90_000);
  });
});

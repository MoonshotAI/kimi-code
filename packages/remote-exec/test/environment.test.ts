import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ConnectionClosedError } from '../src/client/connection';
import { RemoteEnvironment } from '../src/client/remoteEnvironment';
import { TEST_VERSION } from './helpers/loopback';

const require = createRequire(import.meta.url);
const here = import.meta.dirname;

function tsxCli(): string {
  return join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
}

function loopbackLauncher(env?: Record<string, string>) {
  return {
    type: 'command' as const,
    program: process.execPath,
    args: [tsxCli(), join(here, 'fixtures', 'exec-server-child.ts')],
    env: { EXEC_SERVER_VERSION: TEST_VERSION, ...env },
  };
}

describe('RemoteEnvironment over a subprocess loopback', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'remote-exec-environment-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('exposes the Environment surface and runs the fs/process chain', async () => {
    const environment = await RemoteEnvironment.connect({
      workspaceId: 'ws-test',
      environmentId: 'loopback',
      launcher: loopbackLauncher(),
    });
    try {
      expect(environment.identity).toMatchObject({ workspaceId: 'ws-test', environmentId: 'loopback' });
      expect(environment.identity.generation.length).toBeGreaterThan(0);
      expect(environment.capabilities).toEqual(new Set(['fs', 'process', 'terminal']));
      expect(environment.status).toBe('ready');
      expect(environment.executorVersion).toBe(TEST_VERSION);
      expect(environment.host.osKind.length).toBeGreaterThan(0);
      expect(environment.host.pathClass).toBe('posix');
      expect(environment.host.shellPath.length).toBeGreaterThan(0);
      expect(environment.host.homeDir.length).toBeGreaterThan(0);
      expect(environment.host.cwd.length).toBeGreaterThan(0);
      expect(environment.host.tempDir.length).toBeGreaterThan(0);
      expect(environment.path.separator).toBe('/');
      expect(environment.path.isAbsolute('/tmp/x')).toBe(true);
      expect(environment.path.join('/a', 'b')).toBe('/a/b');
      expect(environment.workspace.mapRoots({ workDir: 'rel' }).workDir).toBe(
        environment.path.resolve('rel'),
      );
      expect(environment.fs).toBeDefined();
      expect(environment.process).toBeDefined();
      expect(environment.terminal).toBeDefined();

      const file = join(workDir, 'chain.txt');
      await environment.fs.writeText(file, 'chain-data');
      const proc = await environment.process.spawn('cat', [file], { cwd: workDir });
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      const ended = new Promise<void>((resolve) => {
        proc.stdout.on('end', () => {
          resolve();
        });
      });
      await proc.wait();
      await ended;
      expect(Buffer.concat(chunks).toString()).toBe('chain-data');
    } finally {
      await environment.dispose();
    }
    expect(environment.status).toBe('disposed');
  });

  it('moves to disconnected when the bridge drops and rejects new calls', async () => {
    const environment = await RemoteEnvironment.connect({
      workspaceId: 'ws-test',
      environmentId: 'loopback',
      launcher: loopbackLauncher(),
    });
    const statuses: string[] = [];
    environment.onDidChangeStatus((status) => {
      statuses.push(status);
    });
    const proc = await environment.process.spawn('sleep', ['300']);
    expect(proc.pid).toBeGreaterThan(0);
    await environment.dispose();
    expect(statuses).toContain('disposed');
    await expect(environment.process.spawn('true')).rejects.toThrow(ConnectionClosedError);
  });

  it('marks the environment unavailable and drains in-flight work when the transport drops', async () => {
    const environment = await RemoteEnvironment.connect({
      workspaceId: 'ws-test',
      environmentId: 'loopback',
      launcher: loopbackLauncher({ EXEC_SERVER_EXIT_AFTER_MS: '3000' }),
    });
    const disconnected = new Promise<void>((resolve) => {
      environment.onDidChangeStatus((status) => {
        if (status === 'disconnected') resolve();
      });
    });
    const proc = await environment.process.spawn('sleep', ['300']);
    await disconnected;
    expect(environment.status).toBe('disconnected');
    await expect(proc.wait()).resolves.toBe(-1);
    await expect(environment.fs.readText('/etc/hostname')).rejects.toThrow(ConnectionClosedError);
    await environment.dispose();
  });

  it('detects a half-open executor through the status ping and disconnects', async () => {
    const environment = await RemoteEnvironment.connect({
      workspaceId: 'ws-test',
      environmentId: 'loopback',
      launcher: loopbackLauncher({ EXEC_SERVER_BLOCK_AFTER_MS: '200', EXEC_SERVER_BLOCK_MS: '10000' }),
      controlCallTimeoutMs: 200,
      statusPingIntervalMs: 50,
    });
    await vi.waitFor(() => {
      expect(environment.status).toBe('disconnected');
    }, { timeout: 5_000 });
    await environment.dispose();
  });

  it('keeps a healthy executor connected across status pings', async () => {
    const environment = await RemoteEnvironment.connect({
      workspaceId: 'ws-test',
      environmentId: 'loopback',
      launcher: loopbackLauncher(),
      controlCallTimeoutMs: 200,
      statusPingIntervalMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(environment.status).toBe('ready');
    await environment.dispose();
  });

  it('disconnects when the status ping is answered with an error', async () => {
    const environment = await RemoteEnvironment.connect({
      workspaceId: 'ws-test',
      environmentId: 'loopback',
      launcher: {
        type: 'command' as const,
        program: process.execPath,
        args: [tsxCli(), join(here, 'fixtures', 'exec-server-status-error-child.ts')],
        env: { EXEC_SERVER_VERSION: TEST_VERSION },
      },
      controlCallTimeoutMs: 200,
      statusPingIntervalMs: 50,
    });
    await vi.waitFor(() => {
      expect(environment.status).toBe('disconnected');
    }, { timeout: 5_000 });
    await environment.dispose();
  });

  it('fails to connect when the executor is missing, with exit diagnostics', async () => {
    await expect(
      RemoteEnvironment.connect({
        workspaceId: 'ws-test',
        environmentId: 'loopback',
        launcher: {
          type: 'command',
          program: process.execPath,
          args: ['-e', 'process.exit(127)'],
        },
      }),
    ).rejects.toThrow(/exited before the handshake/);
  });

  it('times out a silent executor inside the initialize window', async () => {
    const started = Date.now();
    const pending = RemoteEnvironment.connect({
      workspaceId: 'ws-test',
      environmentId: 'loopback',
      initializeTimeoutMs: 500,
      launcher: {
        type: 'command',
        program: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      },
    });
    await expect(pending).rejects.toMatchObject({ name: 'HandshakeError', kind: 'timeout' });
    await expect(pending).rejects.toThrow(/initialize timed out after 500ms/);
    await expect(pending).rejects.toThrow(/^(?!.*executor stderr).*$/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('carries the executor stderr tail in the initialize timeout error', async () => {
    const pending = RemoteEnvironment.connect({
      workspaceId: 'ws-test',
      environmentId: 'loopback',
      initializeTimeoutMs: 500,
      launcher: {
        type: 'command',
        program: process.execPath,
        args: ['-e', 'process.stderr.write("Password: "); setInterval(() => {}, 1000)'],
      },
    });
    await expect(pending).rejects.toMatchObject({ name: 'HandshakeError', kind: 'timeout' });
    await expect(pending).rejects.toThrow(/initialize timed out after 500ms; executor stderr: Password:/);
  });
});

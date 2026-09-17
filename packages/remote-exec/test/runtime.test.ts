import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConnectionClosedError } from '../src/client/connection';
import { RemoteRuntime } from '../src/client/remoteRuntime';
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

describe('RemoteRuntime over a subprocess loopback', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'remote-exec-runtime-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('exposes the Runtime surface and runs the fs/process chain', async () => {
    const runtime = await RemoteRuntime.connect({
      workspaceId: 'ws-test',
      runtimeId: 'loopback',
      launcher: loopbackLauncher(),
    });
    try {
      expect(runtime.identity).toMatchObject({ workspaceId: 'ws-test', runtimeId: 'loopback' });
      expect(runtime.identity.generation.length).toBeGreaterThan(0);
      expect(runtime.capabilities).toEqual(new Set(['fs', 'process', 'terminal']));
      expect(runtime.status).toBe('ready');
      expect(runtime.executorVersion).toBe(TEST_VERSION);
      expect(runtime.environment.osKind.length).toBeGreaterThan(0);
      expect(runtime.environment.pathClass).toBe('posix');
      expect(runtime.environment.shellPath.length).toBeGreaterThan(0);
      expect(runtime.environment.homeDir.length).toBeGreaterThan(0);
      expect(runtime.environment.cwd.length).toBeGreaterThan(0);
      expect(runtime.environment.tempDir.length).toBeGreaterThan(0);
      expect(runtime.path.separator).toBe('/');
      expect(runtime.path.isAbsolute('/tmp/x')).toBe(true);
      expect(runtime.path.join('/a', 'b')).toBe('/a/b');
      expect(runtime.workspace.mapRoots({ workDir: 'rel' }).workDir).toBe(
        runtime.path.resolve('rel'),
      );
      expect(runtime.fs).toBeDefined();
      expect(runtime.process).toBeDefined();
      expect(runtime.terminal).toBeDefined();

      const file = join(workDir, 'chain.txt');
      await runtime.fs.writeText(file, 'chain-data');
      const proc = await runtime.process.spawn('cat', [file], { cwd: workDir });
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
      await runtime.dispose();
    }
    expect(runtime.status).toBe('disposed');
  });

  it('moves to disconnected when the bridge drops and rejects new calls', async () => {
    const runtime = await RemoteRuntime.connect({
      workspaceId: 'ws-test',
      runtimeId: 'loopback',
      launcher: loopbackLauncher(),
    });
    const statuses: string[] = [];
    runtime.onDidChangeStatus((status) => {
      statuses.push(status);
    });
    const proc = await runtime.process.spawn('sleep', ['300']);
    expect(proc.pid).toBeGreaterThan(0);
    await runtime.dispose();
    expect(statuses).toContain('disposed');
    await expect(runtime.process.spawn('true')).rejects.toThrow(ConnectionClosedError);
  });

  it('fails to connect when the executor is missing, with exit diagnostics', async () => {
    await expect(
      RemoteRuntime.connect({
        workspaceId: 'ws-test',
        runtimeId: 'loopback',
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
    const pending = RemoteRuntime.connect({
      workspaceId: 'ws-test',
      runtimeId: 'loopback',
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
    const pending = RemoteRuntime.connect({
      workspaceId: 'ws-test',
      runtimeId: 'loopback',
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

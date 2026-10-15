import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ConnectionClosedError } from '#/remote/client/connection';
import { RemoteEnvironment } from '#/remote/client/remoteEnvironment';
import { TEST_VERSION } from './helpers/loopback';

const require = createRequire(import.meta.url);
const here = import.meta.dirname;

function tsxCli(): string {
  return join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
}

function loopbackLauncher() {
  return {
    type: 'command' as const,
    program: process.execPath,
    args: [tsxCli(), join(here, 'fixtures', 'exec-server-child.ts')],
    env: { EXEC_SERVER_VERSION: TEST_VERSION },
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
      environmentId: 'loopback',
      launcher: loopbackLauncher(),
    });
    try {
      expect(environment.identity).toMatchObject({ environmentId: 'loopback' });
      expect(environment.identity.generation.length).toBeGreaterThan(0);
      expect(environment.capabilities).toEqual(new Set(['fs', 'process']));
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

  it('lets the executor kill TERM-resistant children before disposing the launcher', async () => {
    const environment = await RemoteEnvironment.connect({ environmentId: 'loopback', launcher: loopbackLauncher() });
    let pid: number | undefined;
    const alive = (): boolean => {
      try { process.kill(pid!, 0); return true; } catch { return false; }
    };
    try {
      const proc = await environment.process.spawn(process.execPath, ['-e',
        'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
      ], { cwd: workDir });
      pid = proc.pid;
      await new Promise<void>((resolve) => {
        proc.stdout.once('data', () => { resolve(); });
      });
      await environment.dispose();
      await vi.waitFor(() => { expect(alive()).toBe(false); }, { timeout: 5_000 });
    } finally {
      await environment.dispose();
      if (pid !== undefined && alive()) process.kill(pid, 'SIGKILL');
    }
  });

  it('moves to disconnected when the bridge drops and rejects new calls', async () => {
    const environment = await RemoteEnvironment.connect({
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
});

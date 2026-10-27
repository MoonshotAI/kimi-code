import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ConnectionClosedError } from '#/remote/client/connection';
import { RemoteSession } from '#/remote/client/remoteSession';
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

describe('RemoteSession over a subprocess loopback', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'remote-exec-environment-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('exposes the handshake host and runs the fs/process chain', async () => {
    const session = await RemoteSession.connect({
      environmentId: 'loopback',
      launcher: loopbackLauncher(),
    });
    try {
      expect(session.executorVersion).toBe(TEST_VERSION);
      expect(session.host.osKind.length).toBeGreaterThan(0);
      expect(session.host.pathClass).toBe('posix');
      expect(session.host.shellPath.length).toBeGreaterThan(0);
      expect(session.host.homeDir.length).toBeGreaterThan(0);
      expect(session.host.cwd.length).toBeGreaterThan(0);
      expect(session.host.tempDir.length).toBeGreaterThan(0);
      expect(session.fs).toBeDefined();
      expect(session.process).toBeDefined();

      const file = join(workDir, 'chain.txt');
      await session.fs.writeText(file, 'chain-data');
      const proc = await session.process.spawn('cat', [file], { cwd: workDir });
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
      await session.dispose();
    }
  });

  it('lets the executor kill TERM-resistant children before disposing the launcher', async () => {
    const session = await RemoteSession.connect({ environmentId: 'loopback', launcher: loopbackLauncher() });
    let pid: number | undefined;
    const alive = (): boolean => {
      try { process.kill(pid!, 0); return true; } catch { return false; }
    };
    try {
      const proc = await session.process.spawn(process.execPath, ['-e',
        'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
      ], { cwd: workDir });
      pid = proc.pid;
      await new Promise<void>((resolve) => {
        proc.stdout.once('data', () => { resolve(); });
      });
      await session.dispose();
      await vi.waitFor(() => { expect(alive()).toBe(false); }, { timeout: 5_000 });
    } finally {
      await session.dispose();
      if (pid !== undefined && alive()) process.kill(pid, 'SIGKILL');
    }
  });

  it('reports the closed connection and rejects new calls after dispose', async () => {
    const session = await RemoteSession.connect({
      environmentId: 'loopback',
      launcher: loopbackLauncher(),
    });
    const closed: string[] = [];
    session.connection.onDidClose((info) => {
      closed.push(info.kind ?? 'other');
    });
    const proc = await session.process.spawn('sleep', ['300']);
    expect(proc.pid).toBeGreaterThan(0);
    await session.dispose();
    expect(closed).toEqual(['client_closed']);
    await expect(session.process.spawn('true')).rejects.toThrow(ConnectionClosedError);
  });
});

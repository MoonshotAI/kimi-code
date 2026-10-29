import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ConnectionClosedError } from '#/remote/protocol/errors';
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

  it.skipIf(process.platform === 'win32')('uses the real askpass helper for a password retry', { timeout: 60_000 }, async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'remote-ssh-password-'));
    const password = 'päss "word"';
    const argsPath = join(binDir, 'args');
    const fakeSsh = join(binDir, 'ssh');
    await writeFile(fakeSsh, `#!/bin/sh
printf '%s\\n' "$@" > "$TEST_ARGS_FILE"
if [ -z "\${SSH_ASKPASS:-}" ]; then
  printf 'Permission denied (publickey,password)\\n' >&2
  exit 255
fi
provided="$("$SSH_ASKPASS" 'Password:')"
if [ "$provided" != "$EXPECTED_SSH_PASSWORD" ]; then
  printf 'Permission denied (publickey,password)\\n' >&2
  exit 255
fi
exec "$TEST_NODE" "$TEST_TSX" "$TEST_SERVER"
`);
    await chmod(fakeSsh, 0o700);
    vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('SSH_ASKPASS', '');
    vi.stubEnv('TEST_ARGS_FILE', argsPath);
    vi.stubEnv('EXPECTED_SSH_PASSWORD', password);
    vi.stubEnv('TEST_NODE', process.execPath);
    vi.stubEnv('TEST_TSX', tsxCli());
    vi.stubEnv('TEST_SERVER', join(here, 'fixtures', 'exec-server-child.ts'));
    vi.stubEnv('EXEC_SERVER_VERSION', TEST_VERSION);

    let session: RemoteSession | undefined;
    try {
      await expect(RemoteSession.connect({
        environmentId: 'dev-box',
        launcher: { type: 'ssh', host: 'dev-box' },
      })).rejects.toMatchObject({ kind: 'authentication' });

      session = await RemoteSession.connect({
        environmentId: 'dev-box',
        launcher: { type: 'ssh', host: 'dev-box' },
        sshAuth: {
          password,
          command: [process.execPath, tsxCli(), join(here, 'fixtures', 'ssh-askpass-child.ts')],
        },
      });
      expect(session.executorVersion).toBe(TEST_VERSION);
      const args = await readFile(argsPath, 'utf8');
      expect(args).toContain('BatchMode=no');
      expect(args).toContain('NumberOfPasswordPrompts=1');
      expect(args).toContain('StrictHostKeyChecking=accept-new');
      expect(args).not.toContain('BatchMode=yes');
    } finally {
      await session?.dispose();
      vi.unstubAllEnvs();
      await rm(binDir, { recursive: true, force: true });
    }
  });
});

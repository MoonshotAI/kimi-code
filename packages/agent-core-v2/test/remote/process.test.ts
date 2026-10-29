import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RemoteExecConnection } from '#/remote/client/connection';
import { RemoteProcessService } from '#/os/backends/remote/remoteProcess';
import { PROCESS_EXITED_METHOD } from '#/remote/protocol/methods';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { ProcessManager } from '#/remote/server/processManager';
import {
  connectInProcess,
  connectSubprocess,
  createInProcessLoopback,
  RawClient,
  throttleClientPipe,
  type SpawnedExecutor,
} from './helpers/loopback';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`pid ${pid} is still alive`);
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return Buffer.concat(chunks);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function fromB64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

async function startProcess(
  raw: RawClient,
  id: number,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  raw.send({ id, method: 'process/start', params });
  return raw.nextResponse(id);
}

describe('process group over a subprocess loopback', () => {
  let connection: RemoteExecConnection;
  let spawned: SpawnedExecutor;
  let processes: RemoteProcessService;

  beforeAll(async () => {
    ({ connection, spawned } = await connectSubprocess());
    processes = new RemoteProcessService(connection, '/tmp', '/bin/bash');
  }, 60_000);

  afterAll(() => {
    connection.close();
    spawned.bridge.close();
  });

  it('runs a process end to end with stdout, stderr and exit code', async () => {
    const proc = await processes.spawn('bash', ['-c', 'echo hello; echo err >&2; exit 3']);
    const [stdout, stderr, code] = await Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.wait(),
    ]);
    expect(stdout.toString()).toBe('hello\n');
    expect(stderr.toString()).toBe('err\n');
    expect(code).toBe(3);
    expect(proc.exitCode).toBe(3);
    expect(proc.pid).toBeGreaterThan(0);
  });

  it('spawns in the environment defaultCwd when the call omits cwd', async () => {
    const envCwd = await realpath(await mkdtemp(join(tmpdir(), 'kimi-remote-default-cwd-')));
    try {
      expect(envCwd).not.toBe(process.cwd());
      const envProcesses = new RemoteProcessService(connection, envCwd, '/bin/bash');
      const proc = await envProcesses.spawn('pwd', []);
      const [out, code] = await Promise.all([collect(proc.stdout), proc.wait()]);
      expect(code).toBe(0);
      expect(out.toString().trim()).toBe(envCwd);
    } finally {
      await rm(envCwd, { recursive: true, force: true });
    }
  });

  it('sends only explicit env overrides and never the local process env', async () => {
    const witness = 'REMOTE_EXEC_LOCAL_WITNESS_9F3X';
    process.env[witness] = 'local-secret';
    try {
      const withoutOverride = await processes.spawn('sh', ['-c', `printf '[%s]' "$${witness}"`]);
      const [plainOut] = await Promise.all([collect(withoutOverride.stdout), withoutOverride.wait()]);
      expect(plainOut.toString()).toBe('[]');

      const withOverride = await processes.spawn('sh', ['-c', `printf '[%s]' "$${witness}"`], {
        env: { [witness]: 'explicit' },
      });
      const [overrideOut] = await Promise.all([collect(withOverride.stdout), withOverride.wait()]);
      expect(overrideOut.toString()).toBe('[explicit]');
    } finally {
      delete process.env[witness];
    }
  });

  it('delivers tail output emitted after the exit event', async () => {
    const proc = await processes.spawn('bash', ['-c', 'printf early; sleep 0.4; printf late']);
    const code = await proc.wait();
    expect(code).toBe(0);
    const out = await collect(proc.stdout);
    expect(out.toString()).toBe('earlylate');
  });

  it('preserves multi-byte UTF-8 across output packets', async () => {
    const proc = await processes.spawn('bash', ['-c', 'printf "你好🙂世界"; sleep 0.2; printf "结尾"']);
    const [out] = await Promise.all([collect(proc.stdout), proc.wait()]);
    expect(out.toString('utf8')).toBe('你好🙂世界结尾');
  });

  it('kills the whole process group on signal, including children of the leader', async () => {
    const proc = await processes.spawn('sh', ['-c', 'sleep 300 & echo $!; wait']);
    const childPid = await new Promise<number>((resolve, reject) => {
      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = /(\d+)/.exec(buffer);
        if (match !== null) {
          resolve(Number(match[1]));
        }
      });
      setTimeout(() => {
        reject(new Error('timed out waiting for child pid'));
      }, 5_000);
    });
    expect(isAlive(childPid)).toBe(true);
    await proc.kill('SIGTERM');
    await proc.wait();
    await waitForDeath(childPid);
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const processId = randomUUID();
    await connection.call('process/start', {
      processId,
      argv: ['bash', '-c', 'trap "" TERM; sleep 300'],
      cwd: '/tmp',
    });
    const started = Date.now();
    const exited = new Promise<{ exitCode?: number }>((resolve) => {
      const unsubscribe = connection.onNotification(PROCESS_EXITED_METHOD, (params) => {
        const event = params as { processId: string; exitCode: number };
        if (event.processId !== processId) return;
        unsubscribe();
        resolve({ exitCode: event.exitCode });
      });
    });
    await expect(
      connection.call('process/signal', { processId, signal: 'terminate' }),
    ).resolves.toEqual({});
    const result = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('process never exited after terminate'));
        }, 10_000);
      }),
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('cleans group residue when the leader has already exited', async () => {
    const proc = await processes.spawn('sh', ['-c', 'sleep 300 & echo $!; exit 0']);
    const childPid = await new Promise<number>((resolve, reject) => {
      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = /(\d+)/.exec(buffer);
        if (match !== null) {
          resolve(Number(match[1]));
        }
      });
      setTimeout(() => {
        reject(new Error('timed out waiting for child pid'));
      }, 5_000);
    });
    await proc.wait();
    expect(isAlive(childPid)).toBe(true);
    await proc.kill('SIGTERM');
    await waitForDeath(childPid);
  });

  it('kills all managed processes when the connection drops', async () => {
    const proc = await processes.spawn('sleep', ['300']);
    expect(isAlive(proc.pid)).toBe(true);
    connection.close();
    spawned.bridge.close();
    await spawned.bridge.exited;
    await waitForDeath(proc.pid);
  }, 15_000);
});

describe('process output backpressure', () => {
  it('bounds an unread flood and resumes losslessly once the consumer catches up', async () => {
    const { connection, loopback } = await connectInProcess();
    const processes = new RemoteProcessService(connection, '/tmp', '/bin/bash');
    const proc = await processes.spawn('yes', []);

    await delay(500);
    const first = proc.stdout.readableLength;
    await delay(400);
    const second = proc.stdout.readableLength;
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
    expect(second).toBeLessThan(1024 * 1024);

    const collected: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => {
      collected.push(chunk);
    });
    await delay(250);
    await proc.kill('SIGKILL');
    await proc.wait();
    connection.close();
    await loopback.host.done;
    const text = Buffer.concat(collected).toString();
    expect(text.length).toBeGreaterThan(second);
    expect(text).toBe('y\n'.repeat(text.length / 2));
  }, 15_000);
});

describe('stdin write chain recovery', () => {
  it('exempts process/write from the request timeout and settles pending writes when the process dies', async () => {
    const { connection, loopback } = await connectInProcess({
      connect: { requestCallTimeoutMs: 400 },
    });
    const processes = new RemoteProcessService(connection, '/tmp', '/bin/bash');
    const proc = await processes.spawn('sleep', ['300']);

    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    let firstSettled = false;
    const firstWrite = new Promise<Error | null>((resolve) => {
      proc.stdin.write(chunk, (error) => {
        firstSettled = true;
        resolve(error ?? null);
      });
    });
    await delay(1_000);
    expect(firstSettled).toBe(false);
    expect(connection.closed).toBe(false);

    await proc.kill('SIGKILL');
    await expect(firstWrite).resolves.toBeNull();
    await proc.wait();

    const secondError = await new Promise<Error | null>((resolve) => {
      proc.stdin.write(Buffer.from('x'), (error) => {
        resolve(error ?? null);
      });
    });
    expect(secondError).toBeNull();
    connection.close();
    await loopback.host.done;
  }, 15_000);
});

describe('process protocol semantics', () => {
  it('rejects reusing a finished process id while its group is being terminated', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    let childPid: number | undefined;
    try {
      await raw.handshake();
      await startProcess(raw, 1, {
        processId: 'finished-group',
        argv: ['sh', '-c', 'trap "" TERM; sleep 300 </dev/null >/dev/null 2>&1 & echo $!; exit 0'],
        cwd: '/tmp',
      });
      await vi.waitFor(() => {
        expect(raw.notifications('process/closed')).toHaveLength(1);
      });
      childPid = Number(raw.notifications('process/output').map((event) => fromB64(event['chunkBase64'] as string)).join('').trim());
      expect(childPid).toBeGreaterThan(0);
      raw.send({ id: 2, method: 'process/signal', params: { processId: 'finished-group', signal: 'terminate' } });
      expect((await raw.nextResponse(2))['result']).toEqual({});
      const reused = await startProcess(raw, 3, { processId: 'finished-group', argv: ['true'], cwd: '/tmp' });
      expect(reused['error']).toMatchObject({ code: -32600, message: 'duplicate process id finished-group' });
      await waitForDeath(childPid);
    } finally {
      loopback.clientInput.end();
      await loopback.host.done;
      if (childPid !== undefined && childPid > 0 && isAlive(childPid)) process.kill(childPid, 'SIGKILL');
    }
  });

  it('rejects a start whose id is terminated while the start is still in flight', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    raw.sendRaw(
      `${JSON.stringify({ id: 1, method: 'process/start', params: { processId: 'late', argv: ['sleep', '300'], cwd: '/tmp' } })}\n` +
        `${JSON.stringify({ id: 2, method: 'process/signal', params: { processId: 'late', signal: 'terminate' } })}\n`,
    );
    expect((await raw.nextResponse(2))['result']).toEqual({});
    const error = (await raw.nextResponse(1))['error'] as { code: number; message: string };
    expect(error.code).toBe(-32600);
    expect(error.message).toContain('terminated before it started');
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('keeps streaming descendant output after the leader exits', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, {
      processId: 'daemon',
      argv: ['sh', '-c', 'while true; do echo tick; sleep 0.1; done & exit 0'],
      cwd: '/tmp',
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 800);
    });
    const before = raw.notifications('process/output');
    expect(before.length).toBeGreaterThan(0);
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    expect(raw.notifications('process/output').length).toBeGreaterThan(0);
    loopback.clientInput.end();
    await loopback.host.done;
  }, 15_000);

  it('keeps control calls responsive behind a data flood', async () => {
    const loopback = createInProcessLoopback();
    const throttled = throttleClientPipe(loopback, { bytesPerTick: 64 * 1024, tickMs: 25 });
    const connection = await RemoteExecConnection.connect(throttled.pipe, {
      clientName: 'remote-exec-test',
      clientVersion: '0.0.0',
    });
    await connection.call('process/start', {
      processId: 'cat',
      argv: ['cat'],
      cwd: '/tmp',
    });
    await connection.call('process/start', {
      processId: 'flood',
      argv: ['yes'],
      cwd: '/tmp',
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 800);
    });
    expect(throttled.bufferedBytes()).toBeGreaterThan(64 * 1024);

    const started = Date.now();
    const write = connection.call('process/write', {
      processId: 'cat',
      chunkBase64: b64('ping'),
    });
    const signal = connection.call('process/signal', { processId: 'flood', signal: 'kill' });
    await expect(write).resolves.toEqual({});
    await expect(signal).resolves.toEqual({});

    expect(Date.now() - started).toBeLessThan(2_000);

    connection.close();
    throttled.releaseAll();
    await loopback.host.done;
  });

  it('disconnects when the pending outbound bytes breach the fuse', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    const bigFile = join(tmpdir(), `remote-exec-fuse-${randomUUID()}`);
    await writeFile(bigFile, 'A'.repeat(1024 * 1024));
    loopback.serverOutput.pause();

    for (let i = 0; i < 70; i += 1) {
      raw.send({ id: 1000 + i, method: 'fs/readFile', params: { path: bigFile, maxBytes: 1024 * 1024 } });
    }
    const done = await Promise.race([
      loopback.host.done.then(() => 'shutdown' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout');
        }, 15_000);
      }),
    ]);
    expect(done).toBe('shutdown');
    expect(loopback.logs.some((line) => line.includes('fuse'))).toBe(true);
    await rm(bigFile, { force: true });
  });

  it('backpressures writes when the child stops reading stdin', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, {
      processId: 'blocker',
      argv: ['sleep', '300'],
      cwd: '/tmp',
    });

    const chunk = Buffer.alloc(1024 * 1024, 0x61).toString('base64');
    raw.send({
      id: 100,
      method: 'process/write',
      params: { processId: 'blocker', chunkBase64: chunk },
    });
    raw.send({ id: 200, method: 'process/signal', params: { processId: 'blocker', signal: 'kill' } });
    await raw.nextResponse(200, 30_000);
    expect((await raw.nextResponse(100, 30_000))['result']).toEqual({});
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it.each(['shutdown', 'terminate'] as const)('retains background groups beyond five seconds for %s', async (operation) => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, {
      processId: 'daemonizer',
      argv: ['sh', '-c', 'sleep 300 </dev/null >/dev/null 2>&1 & echo $!; exit 0'],
      cwd: '/tmp',
    });
    let childPid = -1;
    const started = Date.now();
    while (childPid < 0 && Date.now() - started < 5_000) {
      const outputs = raw.notifications('process/output');
      for (const output of outputs) {
        const match = /(\d+)/.exec(fromB64(output['chunkBase64'] as string));
        if (match !== null) childPid = Number(match[1]);
      }
      if (childPid < 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    }
    expect(childPid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(raw.notifications('process/closed')).toHaveLength(1);
    });
    expect(isAlive(childPid)).toBe(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      if (operation === 'terminate') {
        raw.send({ id: 2, method: 'process/signal', params: { processId: 'daemonizer', signal: 'terminate' } });
        expect((await raw.nextResponse(2))['result']).toEqual({});
      } else {
        loopback.clientInput.end();
        await loopback.host.done;
      }
      await waitForDeath(childPid);
    } finally {
      loopback.clientInput.end();
      await loopback.host.done;
      if (isAlive(childPid)) process.kill(childPid, 'SIGKILL');
    }
  }, 15_000);
});

describe('shutdown of a process that is still starting', () => {
  it('kills a spawn that finishes after shutdown begins', async () => {
    const host = new HostProcessService();
    const manager = new ProcessManager(() => {}, host);
    const script = join(tmpdir(), `remote-exec-starting-${process.pid}.mjs`);
    await writeFile(script, 'setTimeout(() => {}, 30_000);\n');
    const child = await host.spawn(process.execPath, [script], { cwd: tmpdir(), detached: true });
    const pid = child.pid;
    let releaseSpawn: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const internals = manager as unknown as {
      startPipe(entry: { child?: typeof child; pid: number }, argv: string[], cwd: string, env: unknown): Promise<void>;
    };
    vi.spyOn(internals, 'startPipe').mockImplementation(async (entry) => {
      await held;
      entry.child = child;
      entry.pid = pid;
    });
    try {
      const starting = manager.start({
        processId: 'late',
        argv: [process.execPath, script],
        cwd: tmpdir(),
      });
      await vi.waitFor(() => {
        expect(internals.startPipe).toHaveBeenCalled();
      });
      const terminating = manager.terminateAll();
      releaseSpawn!();
      await expect(starting).rejects.toThrow(/shutting down/);
      await terminating;
      await waitForDeath(pid, 2_000);
    } finally {
      vi.restoreAllMocks();
      if (isAlive(pid)) await child.kill('SIGKILL');
      await child.dispose();
      manager.dispose();
      await rm(script, { force: true });
    }
  });
});

describe('finished process-group ownership', () => {
  it('does not evict live groups at the former cache limit and reaps missing groups', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const manager = new ProcessManager(() => {}, new HostProcessService());
    const internals = manager as unknown as {
      processes: Map<string, unknown>;
      exitedGroups: Map<string, unknown>;
      maybeClose(entry: unknown): void;
    };
    try {
      for (let id = 1; id <= 4097; id += 1) {
        const entry = { processId: String(id), pid: id, exitCode: 0, openStreams: 0, closed: false };
        internals.processes.set(entry.processId, entry);
        internals.maybeClose(entry);
      }
      expect(internals.exitedGroups.size).toBe(4097);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(internals.exitedGroups.size).toBe(4097);
      kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(internals.exitedGroups.size).toBe(0);
    } finally { manager.dispose(); kill.mockRestore(); vi.useRealTimers(); }
  });
});

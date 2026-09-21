import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';

import { HostProcessError } from '@moonshot-ai/agent-core-v2/os/interface/hostProcess';

import { RemoteExecConnection } from '../src/client/connection';
import { RemoteProcessService } from '../src/client/remoteProcess';
import {
  INITIALIZE_METHOD,
  PROCESS_FLOW_METHOD,
  PROCESS_OUTPUT_METHOD,
  PROCESS_START_METHOD,
} from '../src/protocol/methods';
import {
  connectInProcess,
  connectSubprocess,
  createScriptedServer,
  testInitializeResult,
  type ScriptedFrame,
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

  it('merges stderr into stdout when mergeStderr is set', async () => {
    const proc = await processes.spawn('bash', ['-c', 'echo out; echo err >&2'], {
      mergeStderr: true,
    });
    const [merged, code] = await Promise.all([collect(proc.stdout), proc.wait()]);
    expect(code).toBe(0);
    expect(merged.toString()).toContain('out');
    expect(merged.toString()).toContain('err');
  });

  it('maps spawn failures to the process domain error', async () => {
    await expect(
      processes.spawn('definitely-not-a-real-binary-9f3x', []),
    ).rejects.toMatchObject({
      name: 'HostProcessError',
      code: 'os.process.spawn_failed',
    });
  });

  it('points at the cwd when the spawn cwd does not exist', async () => {
    const missing = '/definitely-missing-cwd-9f3x';
    await expect(
      processes.spawn('bash', ['-c', 'true'], { cwd: missing }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(HostProcessError);
      const hostError = error as HostProcessError;
      expect(hostError.code).toBe('os.process.spawn_failed');
      expect(hostError.message).toContain(`cwd ${missing} does not exist or is not a directory`);
      return true;
    });
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

  it('round-trips stdin and closes it on end', async () => {
    const proc = await processes.spawn('cat', []);
    proc.stdin.write('hello ');
    proc.stdin.write('cat');
    proc.stdin.end();
    const [out, code] = await Promise.all([collect(proc.stdout), proc.wait()]);
    expect(out.toString()).toBe('hello cat');
    expect(code).toBe(0);
  });

  it('delivers tail output emitted after the exit event', async () => {
    const proc = await processes.spawn('bash', ['-c', 'printf early; sleep 0.4; printf late']);
    const code = await proc.wait();
    expect(code).toBe(0);
    const out = await collect(proc.stdout);
    expect(out.toString()).toBe('earlylate');
  });

  it('handles a slow consumer of a large output stream', async () => {
    const proc = await processes.spawn('seq', ['1', '300000']);
    await delay(1_000);
    const [out, code] = await Promise.all([collect(proc.stdout), proc.wait()]);
    expect(code).toBe(0);
    const lines = out.toString().trim().split('\n');
    expect(lines.length).toBe(300_000);
    expect(lines[0]).toBe('1');
    expect(lines.at(-1)).toBe('300000');
  });

  it('handles a slow producer on stdin', async () => {
    const proc = await processes.spawn('cat', []);
    // Read stdout concurrently: with end-to-end backpressure the echoed
    // output would otherwise fill the bounded buffer and park the writes.
    const collecting = collect(proc.stdout);
    const chunk = Buffer.alloc(4096, 0x61);
    const writes = 64;
    for (let i = 0; i < writes; i += 1) {
      const canContinue = proc.stdin.write(chunk);
      if (!canContinue) {
        await new Promise((resolve) => {
          proc.stdin.once('drain', resolve);
        });
      }
      await delay(5);
    }
    proc.stdin.end();
    const [out, code] = await Promise.all([collecting, proc.wait()]);
    expect(code).toBe(0);
    expect(out.length).toBe(4096 * writes);
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
      pipeStdin: false,
    });
    const started = Date.now();
    await expect(connection.call('process/terminate', { processId })).resolves.toEqual({
      running: true,
    });
    let exitCode: number | undefined;
    let exited = false;
    const deadline = Date.now() + 10_000;
    while (!exited && Date.now() < deadline) {
      const read = (await connection.call('process/read', { processId, waitMs: 1000 })) as {
        exited: boolean;
        exitCode?: number;
      };
      exited = read.exited;
      exitCode = read.exitCode;
    }
    expect(exited).toBe(true);
    expect(exitCode).not.toBe(0);
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
    // Nobody reads: the buffer fills once, then the executor pauses the
    // child's stdout and the flood stops instead of growing without limit.
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

  it('does not send process/flow to an executor that does not advertise it', async () => {
    const seen: ScriptedFrame[] = [];
    let notify: (value: unknown) => void = () => {};
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        // capabilities: {} — a pre-flow-control executor.
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === 'initialized') {
        notify = (value) => {
          reply(value);
        };
        return;
      }
      seen.push(frame);
      if (frame.method === PROCESS_START_METHOD) {
        const processId = (frame.params as { processId: string }).processId;
        reply({ id: frame.id, result: { processId, pid: 4321 } });
        setTimeout(() => {
          const chunkBase64 = Buffer.alloc(64 * 1024, 0x61).toString('base64');
          for (let seq = 1; seq <= 8; seq += 1) {
            notify({
              method: PROCESS_OUTPUT_METHOD,
              params: { processId, seq, stream: 'stdout', chunkBase64 },
            });
          }
        }, 50);
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
    });
    const processes = new RemoteProcessService(connection, '/tmp', '/bin/bash');
    const proc = await processes.spawn('yes', []);
    await vi.waitFor(() => {
      expect(proc.stdout.readableLength).toBeGreaterThan(0);
    });
    await delay(300);
    expect(seen.some((frame) => frame.method === PROCESS_FLOW_METHOD)).toBe(false);
    expect(connection.closed).toBe(false);
    connection.close();
  });
});

describe('stdin write chain recovery', () => {
  it('retries a timed-out write with the same writeId and keeps later writes flowing', async () => {
    const { connection, loopback } = await connectInProcess({
      connect: { requestCallTimeoutMs: 400 },
    });
    const processes = new RemoteProcessService(connection, '/tmp', '/bin/bash');
    const proc = await processes.spawn('sleep', ['300']);
    // A 1MiB write parks server-side (sleep never reads) and times out
    // client-side; the replay with the same writeId is deduped to accepted.
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const firstError = await new Promise<Error | null>((resolve) => {
      proc.stdin.write(chunk, (error) => {
        resolve(error ?? null);
      });
    });
    expect(firstError).toBeNull();
    // The chain recovered: a later write completes instead of being rejected
    // by the poisoned queue.
    const secondError = await new Promise<Error | null>((resolve) => {
      proc.stdin.write(Buffer.from('x'), (error) => {
        resolve(error ?? null);
      });
    });
    expect(secondError).toBeNull();
    await proc.kill('SIGKILL');
    await proc.wait();
    connection.close();
    await loopback.host.done;
  }, 15_000);
});

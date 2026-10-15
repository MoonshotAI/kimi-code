import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createInProcessLoopback,
  RawClient,
  throttleClientPipe,
} from './helpers/loopback';
import { ProcessManager } from '#/remote/server/processManager';
import { RemoteExecConnection } from '#/remote/client/connection';

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function fromB64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

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

async function startProcess(
  raw: RawClient,
  id: number,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  raw.send({ id, method: 'process/start', params });
  return raw.nextResponse(id);
}

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

describe('finished process-group ownership', () => {
  it('does not evict live groups at the former cache limit and reaps missing groups', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const manager = new ProcessManager(() => {});
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

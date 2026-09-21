import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createInProcessLoopback,
  RawClient,
  throttleClientPipe,
  type InProcessLoopback,
} from './helpers/loopback';
import { RemoteExecConnection } from '../src/client/connection';

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

interface StartedProcess {
  readonly pid: number;
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
      raw.send({ id: 2, method: 'process/terminate', params: { processId: 'finished-group' } });
      expect((await raw.nextResponse(2))['result']).toEqual({ running: false });
      const reused = await startProcess(raw, 3, { processId: 'finished-group', argv: ['true'], cwd: '/tmp' });
      expect(reused['error']).toMatchObject({ code: -32600, message: 'duplicate process id finished-group' });
      await waitForDeath(childPid);
    } finally {
      loopback.clientInput.end();
      await loopback.host.done;
      if (childPid !== undefined && childPid > 0 && isAlive(childPid)) process.kill(childPid, 'SIGKILL');
    }
  });

  it('accepts a resize after a terminal has closed its output', async (testContext) => {
    const ptyAvailable = await import('node-pty').then(() => true, () => false);
    if (!ptyAvailable) testContext.skip();
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    try {
      await raw.handshake();
      const started = await startProcess(raw, 1, {
        processId: 'finished-tty',
        argv: ['sh', '-c', 'exit 0'],
        cwd: '/tmp',
        tty: true,
      });
      expect(started['error']).toBeUndefined();
      await vi.waitFor(() => {
        expect(raw.notifications('process/closed')).toHaveLength(1);
      });
      raw.send({ id: 2, method: 'process/resize', params: { processId: 'finished-tty', cols: 100, rows: 40 } });
      expect((await raw.nextResponse(2))['result']).toEqual({});
    } finally {
      loopback.clientInput.end();
      await loopback.host.done;
    }
  });

  it('rejects the unused process replay method', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    try {
      await raw.handshake();
      raw.send({ id: 1, method: 'process/read', params: { processId: 'unused' } });
      expect((await raw.nextResponse(1))['error']).toMatchObject({ code: -32601 });
    } finally {
      loopback.clientInput.end();
      await loopback.host.done;
    }
  });

  it('rejects a spawn cwd that does not exist with an explicit cwd error', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    const response = await startProcess(raw, 1, {
      processId: 'missing-cwd',
      argv: ['bash', '-c', 'true'],
      cwd: '/definitely-missing-cwd-9f3x',
      pipeStdin: false,
    });
    const error = response['error'] as {
      code: number;
      message: string;
      data?: { domainCode?: string; cwd?: string };
    };
    expect(error.code).toBe(-32602);
    expect(error.message).toBe(
      'cwd /definitely-missing-cwd-9f3x does not exist or is not a directory',
    );
    expect(error.data?.domainCode).toBe('os.process.spawn_failed');
    expect(error.data?.cwd).toBe('/definitely-missing-cwd-9f3x');
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('rejects a spawn cwd that is not a directory with an explicit cwd error', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    const response = await startProcess(raw, 1, {
      processId: 'file-cwd',
      argv: ['bash', '-c', 'true'],
      cwd: '/etc/hosts',
      pipeStdin: false,
    });
    const error = response['error'] as { code: number; message: string };
    expect(error.code).toBe(-32602);
    expect(error.message).toBe('cwd /etc/hosts does not exist or is not a directory');
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('rejects a duplicate processId with -32600', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    const first = await startProcess(raw, 1, {
      processId: 'dup',
      argv: ['sleep', '5'],
      cwd: '/tmp',
      pipeStdin: false,
    });
    expect(first['result']).toMatchObject({ processId: 'dup' });
    const second = await startProcess(raw, 2, {
      processId: 'dup',
      argv: ['sleep', '5'],
      cwd: '/tmp',
      pipeStdin: false,
    });
    expect((second['error'] as { code: number }).code).toBe(-32600);
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('replays a writeId without double-writing', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, { processId: 'cat', argv: ['cat'], cwd: '/tmp', pipeStdin: true });
    raw.send({ id: 2, method: 'process/write', params: { processId: 'cat', chunkBase64: b64('abc'), writeId: 'w1' } });
    expect((await raw.nextResponse(2))['result']).toEqual({ status: 'accepted' });
    raw.send({ id: 3, method: 'process/write', params: { processId: 'cat', chunkBase64: b64('abc'), writeId: 'w1' } });
    expect((await raw.nextResponse(3))['result']).toEqual({ status: 'accepted' });
    raw.send({ id: 4, method: 'process/write', params: { processId: 'cat', chunkBase64: '', writeId: 'w2', eof: true } });
    expect((await raw.nextResponse(4))['result']).toEqual({ status: 'accepted' });
    await vi.waitFor(() => {
      expect(raw.notifications('process/closed')).toHaveLength(1);
    });
    expect(raw.notifications('process/output').map((chunk) => fromB64(chunk['chunkBase64'] as string)).join('')).toBe('abc');
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('refuses writes after stdin EOF and reports unknown processes', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, { processId: 'cat', argv: ['cat'], cwd: '/tmp', pipeStdin: true });
    raw.send({ id: 2, method: 'process/write', params: { processId: 'cat', chunkBase64: '', writeId: 'eof-1', eof: true } });
    expect((await raw.nextResponse(2))['result']).toEqual({ status: 'accepted' });
    raw.send({ id: 3, method: 'process/write', params: { processId: 'cat', chunkBase64: b64('x'), writeId: 'after-eof' } });
    expect((await raw.nextResponse(3))['result']).toEqual({ status: 'stdinClosed' });
    raw.send({ id: 4, method: 'process/write', params: { processId: 'ghost', chunkBase64: b64('x'), writeId: 'w' } });
    expect((await raw.nextResponse(4))['result']).toEqual({ status: 'unknownProcess' });
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
      pipeStdin: false,
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
      pipeStdin: true,
    });
    await connection.call('process/start', {
      processId: 'flood',
      argv: ['yes'],
      cwd: '/tmp',
      pipeStdin: false,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 800);
    });
    expect(throttled.bufferedBytes()).toBeGreaterThan(64 * 1024);

    const started = Date.now();
    const write = connection.call('process/write', {
      processId: 'cat',
      chunkBase64: b64('ping'),
      writeId: 'ping-1',
    });
    const signal = connection.call('process/signal', { processId: 'flood', signal: 'kill' });
    await expect(write).resolves.toEqual({ status: 'accepted' });
    await expect(signal).resolves.toEqual({});
    // FIFO behind the flood backlog would take many seconds at this drain rate.
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
    // Each 1MiB read answers with a ~1.4MB frame; with the consumer stalled
    // the outbound queue passes the 64MiB fuse after ~46 responses.
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

  it('disconnects when a single message exceeds the 64MiB frame cap', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    const header = '{"id":2,"method":"fs/writeFile","params":{"path":"/tmp/oversize","dataBase64":"';
    raw.sendRaw(header + 'A'.repeat(64 * 1024 * 1024));
    const done = await Promise.race([
      loopback.host.done.then(() => 'shutdown' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout');
        }, 10_000);
      }),
    ]);
    expect(done).toBe('shutdown');
    expect(loopback.logs.some((line) => line.includes('protocol violation'))).toBe(true);
  });

  it('backpressures writes when the child stops reading stdin', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, {
      processId: 'blocker',
      argv: ['sleep', '300'],
      cwd: '/tmp',
      pipeStdin: true,
    });
    // A 1MiB write to a pipe nobody reads always exceeds the stream's
    // high-water mark, so the write handler parks deterministically; the kill
    // is processed concurrently and breaks the parked write with stdinClosed.
    const chunk = Buffer.alloc(1024 * 1024, 0x61).toString('base64');
    raw.send({
      id: 100,
      method: 'process/write',
      params: { processId: 'blocker', chunkBase64: chunk, writeId: 'flood-1' },
    });
    raw.send({ id: 200, method: 'process/signal', params: { processId: 'blocker', signal: 'kill' } });
    await raw.nextResponse(200, 30_000);
    const settled = (await raw.nextResponse(100, 30_000))['result'] as { status: string };
    expect(settled.status).toBe('stdinClosed');
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('refuses a start whose id was terminated before it ran', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    raw.send({ id: 1, method: 'process/terminate', params: { processId: 'late' } });
    expect((await raw.nextResponse(1))['result']).toEqual({ running: false });
    raw.send({
      id: 2,
      method: 'process/start',
      params: { processId: 'late', argv: ['sleep', '300'], cwd: '/tmp', pipeStdin: false },
    });
    const error = (await raw.nextResponse(2))['error'] as { code: number; message: string };
    expect(error.code).toBe(-32600);
    expect(error.message).toContain('terminated before it started');
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('terminateAll kills detached descendants after the leader closes its output', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, {
      processId: 'daemonizer',
      argv: ['sh', '-c', 'sleep 300 </dev/null >/dev/null 2>&1 & echo $!; exit 0'],
      cwd: '/tmp',
      pipeStdin: false,
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
    loopback.clientInput.end();
    await loopback.host.done;
    await waitForDeath(childPid);
  }, 15_000);
});

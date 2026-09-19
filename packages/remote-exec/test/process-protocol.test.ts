import { describe, expect, it } from 'vitest';

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
    raw.send({ id: 5, method: 'process/read', params: { processId: 'cat', waitMs: 3000 } });
    const read = (await raw.nextResponse(5))['result'] as {
      chunks: { chunkBase64: string }[];
      closed: boolean;
    };
    const text = read.chunks.map((chunk) => fromB64(chunk.chunkBase64)).join('');
    expect(text).toBe('abc');
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

  it('reads with long-poll, seq paging and a byte budget that always delivers the first chunk', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, {
      processId: 'emitter',
      argv: ['bash', '-c', 'printf aaa; sleep 0.3; printf bbbb; sleep 0.3; printf cc'],
      cwd: '/tmp',
      pipeStdin: false,
    });

    raw.send({ id: 2, method: 'process/read', params: { processId: 'emitter', afterSeq: 0, waitMs: 2000 } });
    const first = (await raw.nextResponse(2))['result'] as {
      chunks: { seq: number; chunkBase64: string }[];
      nextSeq: number;
      exited: boolean;
      closed: boolean;
    };
    expect(first.chunks.length).toBeGreaterThan(0);
    expect(first.chunks[0]!.seq).toBe(1);
    expect(fromB64(first.chunks[0]!.chunkBase64)).toBe('aaa');

    const lastSeq = first.chunks.at(-1)!.seq;
    raw.send({ id: 3, method: 'process/read', params: { processId: 'emitter', afterSeq: lastSeq, maxBytes: 2, waitMs: 2000 } });
    const budgeted = (await raw.nextResponse(3))['result'] as {
      chunks: { seq: number; chunkBase64: string }[];
      nextSeq: number;
    };
    expect(budgeted.chunks.length).toBe(1);
    expect(budgeted.chunks[0]!.chunkBase64.length).toBeGreaterThan(0);

    const collected: { seq: number; chunkBase64: string }[] = [];
    let afterSeq = 0;
    let closed = false;
    let exitCode: number | undefined;
    for (let call = 10; !closed; call += 1) {
      raw.send({
        id: call,
        method: 'process/read',
        params: { processId: 'emitter', afterSeq, waitMs: 2000 },
      });
      const page = (await raw.nextResponse(call))['result'] as {
        chunks: { seq: number; chunkBase64: string }[];
        nextSeq: number;
        exited: boolean;
        exitCode?: number;
        closed: boolean;
      };
      collected.push(...page.chunks);
      afterSeq = page.nextSeq - 1;
      closed = page.closed;
      exitCode = page.exitCode;
    }
    expect(collected.map((chunk) => fromB64(chunk.chunkBase64)).join('')).toBe('aaabbbbcc');
    expect(exitCode).toBe(0);

    raw.send({ id: 99, method: 'process/read', params: { processId: 'emitter', afterSeq, waitMs: 100 } });
    const empty = (await raw.nextResponse(99))['result'] as { chunks: unknown[]; exited: boolean };
    expect(empty.chunks).toEqual([]);
    expect(empty.exited).toBe(true);

    raw.send({ id: 6, method: 'process/read', params: { processId: 'ghost' } });
    expect(((await raw.nextResponse(6))['error'] as { code: number }).code).toBe(-32600);
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('truncates the replay buffer at 1MiB while live push continues', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, {
      processId: 'flood',
      argv: ['seq', '1', '400000'],
      cwd: '/tmp',
      pipeStdin: false,
    });
    const deadline = Date.now() + 15_000;
    let closed = false;
    while (!closed && Date.now() < deadline) {
      const frame = (await raw.nextFrame()) as Record<string, unknown>;
      if (frame['method'] === 'process/closed') closed = true;
    }
    expect(closed).toBe(true);
    raw.send({ id: 2, method: 'process/read', params: { processId: 'flood', afterSeq: 0 } });
    const replay = (await raw.nextResponse(2))['result'] as {
      chunks: { seq: number; chunkBase64: string }[];
      exited: boolean;
    };
    expect(replay.exited).toBe(true);
    expect(replay.chunks.length).toBeGreaterThan(0);
    expect(replay.chunks[0]!.seq).toBeGreaterThan(1);
    const retainedBytes = replay.chunks.reduce(
      (total, chunk) => total + Buffer.from(chunk.chunkBase64, 'base64').length,
      0,
    );
    expect(retainedBytes).toBeLessThanOrEqual(1024 * 1024);
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('removes the process entry after the exited retention window', async () => {
    const loopback = createInProcessLoopback({ tuning: { exitedRetentionMs: 300 } });
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, { processId: 'quick', argv: ['true'], cwd: '/tmp', pipeStdin: false });
    await new Promise((resolve) => {
      setTimeout(resolve, 800);
    });
    raw.send({ id: 2, method: 'process/read', params: { processId: 'quick' } });
    expect(((await raw.nextResponse(2))['error'] as { code: number }).code).toBe(-32600);
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('keeps control calls responsive behind a data flood', async () => {
    const loopback = createInProcessLoopback({
      tuning: { dataLaneWatermarkBytes: 32 * 1024 * 1024 },
    });
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
    const loopback = createInProcessLoopback({
      tuning: { dataLaneWatermarkBytes: 1_000_000_000 },
    });
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, { processId: 'flood', argv: ['yes'], cwd: '/tmp', pipeStdin: false });
    loopback.serverOutput.pause();
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

  it('queues ordinary calls beyond the in-flight cap while control calls proceed', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    await startProcess(raw, 1, { processId: 'idle', argv: ['sleep', '5'], cwd: '/tmp', pipeStdin: true });

    const total = 300;
    for (let i = 0; i < total; i += 1) {
      raw.send({
        id: 1000 + i,
        method: 'process/read',
        params: { processId: 'idle', waitMs: 400 },
      });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    raw.send({
      id: 2,
      method: 'process/write',
      params: { processId: 'idle', chunkBase64: b64('x'), writeId: 'control-1' },
    });
    const control = (await raw.nextResponse(2, 2_000))['result'] as { status: string };
    expect(control.status).toBe('accepted');

    let answered = 0;
    const deadline = Date.now() + 15_000;
    while (answered < total && Date.now() < deadline) {
      const frame = (await raw.nextFrame()) as Record<string, unknown>;
      if (typeof frame['id'] === 'number' && frame['id'] >= 1000) {
        expect(frame['error']).toBeUndefined();
        answered += 1;
      }
    }
    expect(answered).toBe(total);
    loopback.clientInput.end();
    await loopback.host.done;
  });
});

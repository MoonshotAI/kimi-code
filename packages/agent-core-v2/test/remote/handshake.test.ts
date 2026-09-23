import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectionClosedError,
  HandshakeError,
  RemoteExecConnection,
  RequestTimeoutError,
} from '#/remote/client/connection';
import type { BytePipe } from '#/remote/client/execBridge';
import { RpcError } from '#/remote/protocol/errors';
import {
  FS_GET_METADATA_METHOD,
  FS_READ_FILE_METHOD,
  INITIALIZE_METHOD,
  PROCESS_CLOSED_METHOD,
  PROCESS_EXITED_METHOD,
  PROCESS_OUTPUT_METHOD,
  PROCESS_START_METHOD,
  PROCESS_TERMINATE_METHOD,
} from '#/remote/protocol/methods';
import { RemoteProcessService } from '#/remote/client/remoteProcess';
import {
  connectInProcess,
  connectSubprocess,
  createInProcessLoopback,
  createScriptedServer,
  RawClient,
  TEST_ENVIRONMENT,
  TEST_VERSION,
  testInitializeResult,
  type ScriptedFrame,
} from './helpers/loopback';

describe('handshake', () => {
  it('completes initialize/initialized and answers fs/getMetadata', async () => {
    const { connection, loopback } = await connectInProcess();
    expect(connection.executorVersion).toBe('9.9.9-test');
    expect(connection.environment).toEqual(TEST_ENVIRONMENT);
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({
      isDirectory: true,
    });
    connection.close();
    await loopback.host.done;
  });

  it('rejects business calls before initialized with -32600', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    raw.send({ id: 1, method: 'initialize', params: { clientName: 'raw', clientVersion: '0.0.0' } });
    await raw.nextFrame();
    raw.send({ id: 2, method: 'fs/readFile', params: { path: '/etc/hostname' } });
    const response = (await raw.nextFrame()) as { id: number; error: { code: number } };
    expect(response.id).toBe(2);
    expect(response.error.code).toBe(-32600);
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('rejects a duplicate initialize with -32600', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    raw.send({ id: 2, method: 'initialize', params: { clientName: 'raw', clientVersion: '0.0.0' } });
    const response = (await raw.nextFrame()) as { id: number; error: { code: number } };
    expect(response.error.code).toBe(-32600);
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('rejects unknown methods with -32601', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    raw.send({ id: 2, method: 'fs/walk', params: {} });
    const response = (await raw.nextFrame()) as { id: number; error: { code: number } };
    expect(response.error.code).toBe(-32601);
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('disconnects when the peer sends bytes before the initialize response', async () => {
    await expect(
      connectSubprocess({ env: { EXEC_SERVER_BANNER: 'Welcome to the machine\n' } }),
    ).rejects.toThrow();
  });

  it.each([
    ['an unknown notification after the handshake', '{"method":"bogus/notification"}\n'],
    ['a server-to-client request', '{"id":99,"method":"fs/readFile","params":{}}\n'],
  ])('disconnects on %s', async (_label, frame) => {
    const { connection, loopback } = await connectInProcess();
    const closed = new Promise<void>((resolve) => {
      connection.onDidClose(() => {
        resolve();
      });
    });
    loopback.serverOutput.write(frame);
    await closed;
    expect(connection.closed).toBe(true);
    await loopback.host.done;
  });

  it('discards a response with an unknown id without disconnecting', async () => {
    const { connection, loopback } = await connectInProcess();
    loopback.serverOutput.write('{"id":12345,"result":{}}\n');
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    expect(connection.closed).toBe(false);
    connection.close();
    await loopback.host.done;
  });

  it('times out when the executor does not answer initialize', async () => {
    await expect(
      connectSubprocess({
        env: { EXEC_SERVER_DELAY_MS: '3000' },
        connect: { initializeTimeoutMs: 500 },
      }),
    ).rejects.toThrow(HandshakeError);
  });

  it('refuses an executor below MIN_EXECUTOR_VERSION with upgrade guidance', async () => {
    await expect(connectInProcess({ version: '0.0.1' })).rejects.toThrow(/below the minimum/);
  });

  it('refuses a non-posix executor environment', async () => {
    await expect(
      connectInProcess({
        environment: { ...TEST_ENVIRONMENT, osKind: 'Windows', pathClass: 'win32' },
      }),
    ).rejects.toThrow(/not posix/);
  });

  it('fails pending calls when the connection drops', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
    });
    const pending = connection.call(FS_READ_FILE_METHOD, { path: '/nope' });
    connection.close();
    await expect(pending).rejects.toThrow(ConnectionClosedError);
  });

  it('settles queued calls beyond the in-flight cap when the connection closes', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
    });
    const total = 260;
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < total; i += 1) {
      calls.push(connection.call(FS_READ_FILE_METHOD, { path: `/nope-${i}` }));
    }
    connection.close();
    const settled = await Promise.allSettled(calls);
    expect(settled).toHaveLength(total);
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
  });

  it('rejects the handshake with the peer error when initialize is answered with an error', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, error: { code: -32603, message: 'wrong dialect' } });
      }
    });
    await expect(
      RemoteExecConnection.connect(pipe, { clientName: 'test', clientVersion: '0.0.0' }),
    ).rejects.toThrow(/wrong dialect/);
  });
});

describe('request call timeout', () => {
  it('times out a stalled exec call without killing the connection', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === FS_GET_METADATA_METHOD) {
        reply({ id: frame.id, result: { isDirectory: true } });
      }

    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      requestCallTimeoutMs: 100,
    });
    const started = Date.now();
    const call = connection.call(PROCESS_START_METHOD, {
      processId: 'p1',
      argv: ['sleep', '1'],
      cwd: '/tmp',
    });
    await expect(call).rejects.toThrow(RequestTimeoutError);
    await expect(call).rejects.toThrow(/timed out after 100ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(connection.closed).toBe(false);
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    connection.close();
  });

  it('cancels a process start that timed out, so the late spawn cannot go orphan', async () => {
    const seen: ScriptedFrame[] = [];
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === FS_GET_METADATA_METHOD) {
        reply({ id: frame.id, result: { isDirectory: true } });
        return;
      }
      seen.push(frame);

      if (frame.method === PROCESS_TERMINATE_METHOD) {
        reply({ id: frame.id, result: { running: false } });
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      requestCallTimeoutMs: 100,
    });
    const processes = new RemoteProcessService(connection, '/tmp', '/bin/bash');
    await expect(processes.spawn('sleep', ['300'])).rejects.toThrow(RequestTimeoutError);

    await vi.waitFor(() => {
      const start = seen.find((frame) => frame.method === PROCESS_START_METHOD);
      const terminate = seen.find((frame) => frame.method === PROCESS_TERMINATE_METHOD);
      expect(start).toBeDefined();
      expect(terminate).toBeDefined();
      expect((terminate?.params as { processId: string }).processId).toBe(
        (start?.params as { processId: string }).processId,
      );
    });
    expect(connection.closed).toBe(false);
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    connection.close();
  });

  it('discards a late response to a timed-out request', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === FS_GET_METADATA_METHOD) {
        reply({ id: frame.id, result: { isDirectory: true } });
        return;
      }
      if (frame.method === FS_READ_FILE_METHOD) {
        setTimeout(() => {
          reply({ id: frame.id, result: { dataBase64: '', eof: true } });
        }, 300);
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      requestCallTimeoutMs: 100,
    });
    const call = connection.call(FS_READ_FILE_METHOD, { path: '/etc/hostname' });
    await expect(call).rejects.toThrow(RequestTimeoutError);

    await new Promise((resolve) => {
      setTimeout(resolve, 600);
    });
    expect(connection.closed).toBe(false);
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    connection.close();
  });

  it('settles a stale request when its connection generation is replaced', async () => {
    let processStartReply!: (value: unknown) => void;
    const firstPipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }

      if (frame.method === PROCESS_START_METHOD) {
        processStartReply = reply;
      }
    });
    const first = await RemoteExecConnection.connect(firstPipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
    });
    const stale = first.call(PROCESS_START_METHOD, {
      processId: 'p1',
      argv: ['sleep', '1'],
      cwd: '/tmp',
    });

    first.close();
    await expect(stale).rejects.toThrow(ConnectionClosedError);

    processStartReply({ id: 2, result: { pid: 1 } });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(first.closed).toBe(true);
    const secondPipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === FS_GET_METADATA_METHOD) {
        reply({ id: frame.id, result: { isDirectory: true } });
      }
    });
    const second = await RemoteExecConnection.connect(secondPipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
    });
    await expect(second.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    second.close();
  });
});

describe('initialize timeout default', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects when the executor answers within the default window', async () => {
    vi.useFakeTimers();
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        setTimeout(() => {
          reply({ id: frame.id, result: testInitializeResult() });
        }, 5_000);
      }
    });
    const pending = RemoteExecConnection.connect(pipe, { clientName: 'test', clientVersion: '0.0.0' });
    await vi.advanceTimersByTimeAsync(5_000);
    const connection = await pending;
    expect(connection.executorVersion).toBe(TEST_VERSION);
    connection.close();
  });

  it('fails as a handshake timeout when the executor passes the default window', async () => {
    vi.useFakeTimers();
    const pipe = createScriptedServer(() => {});
    const pending = RemoteExecConnection.connect(pipe, { clientName: 'test', clientVersion: '0.0.0' });
    const message = expect(pending).rejects.toThrow(/timed out after 10000ms/);
    const kind = expect(pending).rejects.toMatchObject({ name: 'HandshakeError', kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(11_000);
    await message;
    await kind;
  });
});

describe('notification dispatch', () => {
  function notificationScripting(script: (notify: (value: unknown) => void) => void): BytePipe {
    return createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === 'initialized') {
        script((value: unknown) => {
          reply(value);
        });
        return;
      }
      if (frame.method === FS_GET_METADATA_METHOD) {
        reply({ id: frame.id, result: { isDirectory: true } });
      }
    });
  }

  async function settleDispatch(): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
  }

  it('drops malformed process notifications without closing the connection', async () => {
    const pipe = notificationScripting((notify) => {
      notify({ method: PROCESS_OUTPUT_METHOD, params: { processId: 'p1', seq: 1, stream: 'stdout', chunkBase64: null } });
      notify({ method: PROCESS_OUTPUT_METHOD, params: { processId: 'p1', seq: 2, stream: 'bogus', chunkBase64: 'eA==' } });
      notify({ method: PROCESS_EXITED_METHOD, params: { processId: 'p1', seq: 3, exitCode: 'zero' } });
      notify({ method: PROCESS_CLOSED_METHOD, params: null });
    });
    const connection = await RemoteExecConnection.connect(pipe, { clientName: 'test', clientVersion: '0.0.0' });
    const processService = new RemoteProcessService(connection, '/tmp', '/bin/bash');
    void processService;
    await settleDispatch();
    expect(connection.closed).toBe(false);
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    connection.close();
  });

  it('contains a throwing notification handler instead of crashing the process', async () => {
    const pipe = notificationScripting((notify) => {
      notify({
        method: PROCESS_OUTPUT_METHOD,
        params: { processId: 'p1', seq: 1, stream: 'stdout', chunkBase64: Buffer.from('x').toString('base64') },
      });
    });
    const connection = await RemoteExecConnection.connect(pipe, { clientName: 'test', clientVersion: '0.0.0' });
    connection.onNotification(PROCESS_OUTPUT_METHOD, () => {
      throw new Error('boom');
    });
    await settleDispatch();
    expect(connection.closed).toBe(false);
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    connection.close();
  });
});

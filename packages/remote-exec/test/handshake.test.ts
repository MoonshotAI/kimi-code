import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectionClosedError,
  ControlCallTimeoutError,
  HandshakeError,
  RemoteExecConnection,
  RequestTimeoutError,
} from '../src/client/connection';
import type { BytePipe } from '../src/client/execBridge';
import { LineFrameDecoder } from '../src/protocol/codec';
import { RpcError } from '../src/protocol/errors';
import {
  ENVIRONMENT_STATUS_METHOD,
  FS_READ_FILE_METHOD,
  INITIALIZE_METHOD,
  PROCESS_READ_METHOD,
  PROCESS_START_METHOD,
  type InitializeResult,
} from '../src/protocol/methods';
import {
  connectInProcess,
  connectSubprocess,
  createInProcessLoopback,
  RawClient,
  TEST_ENVIRONMENT,
  TEST_VERSION,
} from './helpers/loopback';

type ScriptedFrame = { id?: number; method?: string; params?: unknown };

// A minimal server-end pipe scripted per test: each inbound frame is handed to
// onFrame, which decides whether (and when) to reply — letting tests stall
// specific methods after a good handshake.
function createScriptedServer(
  onFrame: (frame: ScriptedFrame, reply: (value: unknown) => void) => void,
): BytePipe {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const decoder = new LineFrameDecoder();
  clientToServer.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      onFrame(frame as ScriptedFrame, (value) => {
        serverToClient.write(`${JSON.stringify(value)}\n`);
      });
    }
  });
  return {
    write: (chunk) => {
      clientToServer.write(chunk);
    },
    end: () => {
      clientToServer.end();
    },
    onData: (listener) => {
      serverToClient.on('data', listener);
    },
    onEnd: (listener) => {
      serverToClient.on('end', listener);
    },
    onError: (listener) => {
      serverToClient.on('error', listener);
    },
  };
}

function testInitializeResult(): InitializeResult {
  return { executorVersion: TEST_VERSION, environment: TEST_ENVIRONMENT, capabilities: {} };
}

describe('handshake', () => {
  it('completes initialize/initialized and answers environment/status', async () => {
    const { connection, loopback } = await connectInProcess();
    expect(connection.executorVersion).toBe('9.9.9-test');
    expect(connection.environment).toEqual(TEST_ENVIRONMENT);
    expect(connection.capabilities).toEqual({});
    await expect(connection.call('environment/status')).resolves.toEqual({ status: 'ready' });
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

  it('disconnects on an unknown notification after the handshake', async () => {
    const { connection, loopback } = await connectInProcess();
    const closed = new Promise<void>((resolve) => {
      connection.onDidClose(() => {
        resolve();
      });
    });
    loopback.serverOutput.write('{"method":"bogus/notification"}\n');
    await closed;
    expect(connection.closed).toBe(true);
    await loopback.host.done;
  });

  it('disconnects on a server-to-client request', async () => {
    const { connection, loopback } = await connectInProcess();
    const closed = new Promise<void>((resolve) => {
      connection.onDidClose(() => {
        resolve();
      });
    });
    loopback.serverOutput.write('{"id":99,"method":"fs/readFile","params":{}}\n');
    await closed;
    expect(connection.closed).toBe(true);
    await loopback.host.done;
  });

  it('disconnects on a response with an unknown id', async () => {
    const { connection, loopback } = await connectInProcess();
    const closed = new Promise<void>((resolve) => {
      connection.onDidClose(() => {
        resolve();
      });
    });
    loopback.serverOutput.write('{"id":12345,"result":{}}\n');
    await closed;
    expect(connection.closed).toBe(true);
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
    const { connection, loopback } = await connectInProcess();
    const pending = connection.call('process/read', { processId: 'nope', waitMs: 0 });
    await expect(pending).rejects.toThrow(RpcError);
    const slow = connection.call('process/read', { processId: 'nope2', waitMs: 10_000 });
    connection.close();
    await expect(slow).rejects.toThrow(ConnectionClosedError);
    await loopback.host.done;
  });

  it('settles queued calls beyond the in-flight cap when the connection closes', async () => {
    const { connection, loopback } = await connectInProcess();
    await connection.call('process/start', {
      processId: 'idle',
      argv: ['sleep', '5'],
      cwd: '/tmp',
      pipeStdin: false,
    });
    const total = 260;
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < total; i += 1) {
      calls.push(connection.call('process/read', { processId: 'idle', waitMs: 30_000 }));
    }
    connection.close();
    const settled = await Promise.allSettled(calls);
    expect(settled).toHaveLength(total);
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    await loopback.host.done;
  });

  it('rejects the handshake with the peer error when initialize is answered with an error', async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const pipe = {
      write: (chunk: Uint8Array) => {
        clientToServer.write(chunk);
      },
      end: () => {
        clientToServer.end();
      },
      onData: (listener: (chunk: Uint8Array) => void) => {
        serverToClient.on('data', listener);
      },
      onEnd: (listener: () => void) => {
        serverToClient.on('end', listener);
      },
      onError: (listener: (error: Error) => void) => {
        serverToClient.on('error', listener);
      },
    };
    clientToServer.on('data', () => {
      serverToClient.write('{"id":1,"error":{"code":-32603,"message":"wrong dialect"}}\n');
    });
    await expect(
      RemoteExecConnection.connect(pipe, { clientName: 'test', clientVersion: '0.0.0' }),
    ).rejects.toThrow(/wrong dialect/);
  });
});

describe('control call timeout', () => {
  it('fails an unanswered control call within the bound and closes the connection', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
      }
      // Every later call is left unanswered: the executor stalled after the handshake.
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      controlCallTimeoutMs: 100,
    });
    const started = Date.now();
    const call = connection.call(ENVIRONMENT_STATUS_METHOD);
    await expect(call).rejects.toThrow(ConnectionClosedError);
    await expect(call).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(connection.closed).toBe(true);
    expect(connection.closeReason?.error).toBeInstanceOf(ControlCallTimeoutError);
  });

  it('cancels an outstanding long-poll when a control call timeout closes the connection', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      controlCallTimeoutMs: 100,
    });
    const longPoll = connection.call(PROCESS_READ_METHOD, { processId: 'p1', waitMs: 30_000 });
    const control = connection.call(ENVIRONMENT_STATUS_METHOD);
    await expect(control).rejects.toThrow(ConnectionClosedError);
    await expect(longPoll).rejects.toThrow(ConnectionClosedError);
    expect(connection.closed).toBe(true);
  });

  it('lets a long-poll process/read outlive the control call timeout', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === PROCESS_READ_METHOD) {
        setTimeout(() => {
          reply({ id: frame.id, result: { chunks: [], nextSeq: 0, exited: false, closed: false } });
        }, 300);
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      controlCallTimeoutMs: 100,
    });
    const result = await connection.call(PROCESS_READ_METHOD, { processId: 'p1', waitMs: 30_000 });
    expect(result).toEqual({ chunks: [], nextSeq: 0, exited: false, closed: false });
    expect(connection.closed).toBe(false);
    connection.close();
  });
});

describe('request call timeout', () => {
  it('times out a stalled exec call without killing the connection', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === ENVIRONMENT_STATUS_METHOD) {
        reply({ id: frame.id, result: { status: 'ready' } });
      }
      // process/start is left unanswered: the executor stalled on one request.
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
    await expect(connection.call(ENVIRONMENT_STATUS_METHOD)).resolves.toEqual({ status: 'ready' });
    connection.close();
  });

  it('discards a late response to a timed-out request', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === ENVIRONMENT_STATUS_METHOD) {
        reply({ id: frame.id, result: { status: 'ready' } });
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
    // The answer lands after the request already failed: it must be dropped
    // silently, not fault the connection as a response with an unknown id.
    await new Promise((resolve) => {
      setTimeout(resolve, 600);
    });
    expect(connection.closed).toBe(false);
    await expect(connection.call(ENVIRONMENT_STATUS_METHOD)).resolves.toEqual({ status: 'ready' });
    connection.close();
  });

  it('settles a stale request when its connection generation is replaced', async () => {
    const firstToServer = new PassThrough();
    const firstToClient = new PassThrough();
    const decoder = new LineFrameDecoder();
    firstToServer.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const request = frame as ScriptedFrame;
        if (request.method === INITIALIZE_METHOD) {
          firstToClient.write(`${JSON.stringify({ id: request.id, result: testInitializeResult() })}\n`);
        }
        // process/start is left unanswered: generation 1 stalls on it.
      }
    });
    const firstPipe: BytePipe = {
      write: (chunk) => {
        firstToServer.write(chunk);
      },
      end: () => {
        firstToServer.end();
      },
      onData: (listener) => {
        firstToClient.on('data', listener);
      },
      onEnd: (listener) => {
        firstToClient.on('end', listener);
      },
      onError: (listener) => {
        firstToClient.on('error', listener);
      },
    };
    const first = await RemoteExecConnection.connect(firstPipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
    });
    const stale = first.call(PROCESS_START_METHOD, {
      processId: 'p1',
      argv: ['sleep', '1'],
      cwd: '/tmp',
    });
    // A reconnect replaces the connection generation: disposal settles the old
    // generation's in-flight requests instead of replaying them.
    first.close();
    await expect(stale).rejects.toThrow(ConnectionClosedError);
    // A late response on the replaced generation's pipe is inert.
    firstToClient.write('{"id":2,"result":{"processId":"p1","pid":1}}\n');
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(first.closed).toBe(true);
    const secondPipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === ENVIRONMENT_STATUS_METHOD) {
        reply({ id: frame.id, result: { status: 'ready' } });
      }
    });
    const second = await RemoteExecConnection.connect(secondPipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
    });
    await expect(second.call(ENVIRONMENT_STATUS_METHOD)).resolves.toEqual({ status: 'ready' });
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

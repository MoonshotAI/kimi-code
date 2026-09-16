import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ConnectionClosedError, HandshakeError, RemoteExecConnection } from '../src/client/connection';
import { RpcError } from '../src/protocol/errors';
import {
  connectInProcess,
  connectSubprocess,
  createInProcessLoopback,
  RawClient,
  TEST_ENVIRONMENT,
} from './helpers/loopback';

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

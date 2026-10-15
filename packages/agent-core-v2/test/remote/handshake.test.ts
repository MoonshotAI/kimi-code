import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectionClosedError,
  RemoteExecConnection,
  RequestTimeoutError,
} from '#/remote/client/connection';
import type { BytePipe } from '#/remote/client/execBridge';
import {
  FS_GET_METADATA_METHOD,
  FS_READ_FILE_METHOD,
  INITIALIZE_METHOD,
  PROCESS_OUTPUT_METHOD,
  PROCESS_SIGNAL_METHOD,
  PROCESS_START_METHOD,
} from '#/remote/protocol/methods';
import { RemoteProcessService } from '#/remote/client/remoteProcess';
import {
  connectInProcess,
  connectSubprocess,
  createScriptedServer,
  TEST_ENVIRONMENT,
  testInitializeResult,
  type ScriptedFrame,
} from './helpers/loopback';

describe('handshake', () => {
  it('disconnects when the peer sends bytes before the initialize response', async () => {
    await expect(
      connectSubprocess({ env: { EXEC_SERVER_BANNER: 'Welcome to the machine\n' } }),
    ).rejects.toThrow();
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
    const rejections: Promise<void>[] = [];
    for (let i = 0; i < 260; i += 1) {
      rejections.push(
        expect(connection.call(FS_READ_FILE_METHOD, { path: `/nope-${i}` })).rejects.toThrow(ConnectionClosedError),
      );
    }
    connection.close();
    await Promise.all(rejections);
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

      if (frame.method === PROCESS_SIGNAL_METHOD) {
        reply({ id: frame.id, result: {} });
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
      const cancel = seen.find((frame) => frame.method === PROCESS_SIGNAL_METHOD);
      expect(start).toBeDefined();
      expect(cancel).toBeDefined();
      expect(cancel?.params).toMatchObject({
        processId: (start?.params as { processId: string }).processId,
        signal: 'terminate',
      });
    });
    expect(connection.closed).toBe(false);
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    connection.close();
  });
});

describe('initialize timeout default', () => {
  afterEach(() => {
    vi.useRealTimers();
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

describe('liveness heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the connection and fails pending calls when the pong does not arrive', async () => {
    vi.useFakeTimers();
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      livenessIntervalMs: 100,
      livenessTimeoutMs: 50,
    });
    const stalled = connection.call(FS_READ_FILE_METHOD, { path: '/x' });
    const rejection = expect(stalled).rejects.toThrow(ConnectionClosedError);
    await vi.advanceTimersByTimeAsync(200);
    await rejection;
    expect(connection.closed).toBe(true);
    expect(connection.closeReason?.reason).toMatch(/liveness ping timed out/);
    expect(connection.closeReason?.kind).toBe('liveness');
  });
});

describe('notification dispatch', () => {
  function notificationScripting(script: (notify: (value: unknown) => void) => void): BytePipe {
    return createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
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

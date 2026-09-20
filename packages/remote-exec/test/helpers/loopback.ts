import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

import type { BytePipe, ExecBridge } from '../../src/client/execBridge';
import { RemoteExecConnection, type ConnectOptions } from '../../src/client/connection';
import { LineFrameDecoder } from '../../src/protocol/codec';
import type { InitializeResult, RemoteEnvironmentInfo } from '../../src/protocol/methods';
import { StdioHost, type StdioHostTuning } from '../../src/server/stdioHost';

export const TEST_VERSION = '9.9.9-test';

export const TEST_ENVIRONMENT: RemoteEnvironmentInfo = {
  osKind: 'Linux',
  osArch: 'x64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  cwd: '/tmp',
  tempDir: '/tmp',
};

export type ScriptedFrame = { id?: number; method?: string; params?: unknown };

// A minimal server-end pipe scripted per test: each inbound frame is handed to
// onFrame, which decides whether (and when) to reply — letting tests stall
// specific methods after a good handshake.
export function createScriptedServer(
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

export function testInitializeResult(): InitializeResult {
  return { executorVersion: TEST_VERSION, environment: TEST_ENVIRONMENT, capabilities: {} };
}

export interface InProcessLoopback {
  readonly host: StdioHost;
  readonly clientPipe: BytePipe;
  readonly serverOutput: PassThrough;
  readonly clientInput: PassThrough;
  readonly logs: string[];
}

export function createInProcessLoopback(options?: {
  readonly environment?: RemoteEnvironmentInfo;
  readonly version?: string;
  readonly tuning?: StdioHostTuning;
}): InProcessLoopback {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const logs: string[] = [];
  const host = new StdioHost({
    version: options?.version ?? TEST_VERSION,
    environment: options?.environment ?? TEST_ENVIRONMENT,
    input: clientToServer,
    output: serverToClient,
    log: (line) => {
      logs.push(line);
    },
    tuning: options?.tuning,
  });
  const clientPipe: BytePipe = {
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
      clientToServer.on('error', listener);
    },
  };
  host.start();
  return { host, clientPipe, serverOutput: serverToClient, clientInput: clientToServer, logs };
}

export async function connectInProcess(
  options?: {
    environment?: RemoteEnvironmentInfo;
    version?: string;
    tuning?: StdioHostTuning;
    connect?: Partial<ConnectOptions>;
  },
): Promise<{ connection: RemoteExecConnection; loopback: InProcessLoopback }> {
  const loopback = createInProcessLoopback(options);
  const connection = await RemoteExecConnection.connect(loopback.clientPipe, {
    clientName: 'remote-exec-test',
    clientVersion: '0.0.0',
    ...options?.connect,
  });
  return { connection, loopback };
}

const require = createRequire(import.meta.url);
const here = import.meta.dirname;

function resolveTsxCli(): string {
  const packageJson = require.resolve('tsx/package.json');
  return join(dirname(packageJson), 'dist', 'cli.mjs');
}

export interface SpawnedExecutor {
  readonly bridge: ExecBridge;
  readonly child: ChildProcess;
}

export async function spawnExecutorBridge(env?: Record<string, string>): Promise<SpawnedExecutor> {
  const fixture = join(here, '..', 'fixtures', 'exec-server-child.ts');
  const { ExecBridge } = await import('../../src/client/execBridge');
  const child = spawn(process.execPath, [resolveTsxCli(), fixture], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const bridge = ExecBridge.adopt(child);
  return { bridge, child };
}

export async function connectSubprocess(options?: {
  env?: Record<string, string>;
  connect?: Partial<ConnectOptions>;
}): Promise<{ connection: RemoteExecConnection; spawned: SpawnedExecutor }> {
  const spawned = await spawnExecutorBridge({ EXEC_SERVER_VERSION: TEST_VERSION, ...options?.env });
  const handshake = RemoteExecConnection.connect(spawned.bridge, {
    clientName: 'remote-exec-test',
    clientVersion: '0.0.0',
    ...options?.connect,
  });
  const exitWatch = spawned.bridge.exited.then((exit) => {
    throw new Error(
      `executor exited before handshake (code ${exit.code ?? 'null'}): ${spawned.bridge.getStderrTail().trim()}`,
    );
  });
  const silence = (promise: Promise<unknown>): void => {
    promise.catch(() => {});
  };
  try {
    const connection = await Promise.race([handshake, exitWatch]);
    silence(exitWatch);
    return { connection, spawned };
  } catch (error) {
    silence(handshake);
    spawned.bridge.close();
    throw error;
  }
}

export class RawClient {  private readonly decoder = new LineFrameDecoder();
  private readonly frames: unknown[] = [];
  private waiter: (() => void) | undefined;

  constructor(private readonly loopback: InProcessLoopback) {
    loopback.serverOutput.on('data', (chunk: Buffer) => {
      this.frames.push(...this.decoder.push(chunk));
      this.waiter?.();
      this.waiter = undefined;
    });
  }

  send(value: unknown): void {
    this.loopback.clientInput.write(`${JSON.stringify(value)}\n`);
  }

  sendRaw(text: string): void {
    this.loopback.clientInput.write(text);
  }

  async nextFrame(timeoutMs = 5_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.frames.shift();
      if (frame !== undefined) return frame;
      if (Date.now() >= deadline) {
        throw new Error('timed out waiting for a server frame');
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now())));
      });
    }
  }

  async nextResponse(id: number, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex(
        (frame) =>
          frame !== null &&
          typeof frame === 'object' &&
          (frame as Record<string, unknown>)['id'] === id,
      );
      if (index >= 0) {
        const [frame] = this.frames.splice(index, 1);
        return frame as Record<string, unknown>;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for response id ${id}`);
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now())));
      });
    }
  }

  notifications(method: string): Record<string, unknown>[] {
    const matched: Record<string, unknown>[] = [];
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const frame = this.frames[i] as Record<string, unknown>;
      if (frame['method'] === method) {
        matched.unshift((frame['params'] ?? {}) as Record<string, unknown>);
        this.frames.splice(i, 1);
      }
    }
    return matched;
  }

  async handshake(version?: string): Promise<void> {
    this.send({ id: 1, method: 'initialize', params: { clientName: 'raw', clientVersion: '0.0.0' } });
    const response = (await this.nextFrame()) as { id: number; result: { executorVersion: string } };
    if (version !== undefined) {
      if (response.result.executorVersion !== version) {
        throw new Error(`unexpected executor version ${response.result.executorVersion}`);
      }
    }
    this.send({ method: 'initialized' });
  }
}

export interface ThrottledPipe {
  readonly pipe: BytePipe;
  releaseAll(): void;
  bufferedBytes(): number;
}

// Sits between the server output and the client connection, simulating a slow
// consumer on the wire. Inbound bytes are pulled from the server output only
// up to a small cap, so backpressure reaches the server's outbound writer and
// its lane scheduling/watermark logic is exercised for real.
export function throttleClientPipe(
  loopback: InProcessLoopback,
  options: { readonly bytesPerTick: number; readonly tickMs: number },
): ThrottledPipe {
  const source = loopback.serverOutput;
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const endListeners = new Set<() => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const maxBuffered = Math.max(options.bytesPerTick * 2, 16 * 1024);
  let buffered: Buffer[] = [];
  let bufferedTotal = 0;
  let release = false;
  let sourceEnded = false;
  let endFired = false;

  const fireEnd = (): void => {
    if (endFired) return;
    endFired = true;
    for (const listener of endListeners) listener();
    endListeners.clear();
  };

  const emit = (chunk: Buffer): void => {
    for (const listener of dataListeners) listener(chunk);
  };

  const pull = (): void => {
    let chunk: Buffer | null;
    while (bufferedTotal < maxBuffered && (chunk = source.read() as Buffer | null) !== null) {
      buffered.push(chunk);
      bufferedTotal += chunk.length;
    }
  };

  const tick = (): void => {
    if (release) {
      let chunk: Buffer | null;
      while ((chunk = source.read() as Buffer | null) !== null) emit(chunk);
      if (sourceEnded) fireEnd();
      return;
    }
    pull();
    let budget = options.bytesPerTick;
    while (budget > 0 && buffered.length > 0) {
      const head = buffered[0]!;
      if (head.length <= budget) {
        buffered.shift();
        bufferedTotal -= head.length;
        budget -= head.length;
        emit(head);
      } else {
        const part = head.subarray(0, budget);
        buffered[0] = head.subarray(budget);
        bufferedTotal -= part.length;
        budget = 0;
        emit(part);
      }
    }
    pull();
    if (buffered.length === 0 && sourceEnded) fireEnd();
  };

  source.on('readable', tick);
  source.on('end', () => {
    sourceEnded = true;
  });
  source.on('error', (error: Error) => {
    for (const listener of errorListeners) listener(error);
  });
  const timer = setInterval(tick, options.tickMs);
  timer.unref?.();

  return {
    pipe: {
      write: (chunk) => {
        loopback.clientInput.write(chunk);
      },
      end: () => {
        loopback.clientInput.end();
      },
      onData: (listener) => {
        dataListeners.add(listener);
      },
      onEnd: (listener) => {
        if (endFired) {
          listener();
          return;
        }
        endListeners.add(listener);
      },
      onError: (listener) => {
        errorListeners.add(listener);
      },
    },
    releaseAll: () => {
      release = true;
    },
    bufferedBytes: () => bufferedTotal + (source.readableLength ?? 0),
  };
}

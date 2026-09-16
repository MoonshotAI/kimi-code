import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import {
  HostProcessError,
  HostProcessErrorCode,
  OsProcessErrors,
  type HostProcessOptions,
  type IHostProcess,
  type IHostProcessService,
} from '@moonshot-ai/agent-core-v2/os/interface/hostProcess';

import { RpcError } from '#/protocol/errors';
import {
  PROCESS_CLOSED_METHOD,
  PROCESS_EXITED_METHOD,
  PROCESS_OUTPUT_METHOD,
  PROCESS_SIGNAL_METHOD,
  PROCESS_START_METHOD,
  PROCESS_WRITE_METHOD,
  type ProcessClosedNotification,
  type ProcessExitedNotification,
  type ProcessOutputNotification,
  type ProcessOutputStream,
  type ProcessStartResult,
  type ProcessWriteResult,
} from '#/protocol/methods';
import { ConnectionClosedError, type RemoteExecConnection } from './connection';

const HOST_PROCESS_CODES: ReadonlySet<string> = new Set(Object.values(OsProcessErrors.codes));

export function toRemoteProcessError(error: unknown): Error {
  if (!(error instanceof RpcError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const data = error.data;
  const domainCode =
    data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)['domainCode']
      : undefined;
  if (typeof domainCode === 'string' && HOST_PROCESS_CODES.has(domainCode)) {
    return new HostProcessError(domainCode as HostProcessErrorCode, error.message, {
      details: data as Record<string, unknown>,
    });
  }
  return error;
}

class PushReadable extends Readable {
  override _read(): void {}

  endStream(): void {
    this.push(null);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class RemoteProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;

  pid = -1;
  private currentExitCode: number | null = null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private readonly exitPromise: Promise<number>;
  private resolveExit!: (code: number) => void;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly connection: RemoteExecConnection,
    private readonly processId: string,
    mergeStderr: boolean,
  ) {
    this.stdout = new PushReadable();
    this.stderr = mergeStderr ? this.stdout : new PushReadable();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.enqueueWrite(chunk, false, callback);
      },
      final: (callback) => {
        this.enqueueWrite(Buffer.alloc(0), true, callback);
      },
    });
    this.exitPromise = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  attach(pid: number): void {
    this.pid = pid;
  }

  get exitCode(): number | null {
    return this.currentExitCode;
  }

  private enqueueWrite(
    chunk: Buffer,
    eof: boolean,
    callback: (error?: Error | null) => void,
  ): void {
    const writeId = randomUUID();
    this.writeChain = this.writeChain.then(() => this.sendWrite(chunk, eof, writeId, 0));
    this.writeChain.then(
      () => {
        callback();
      },
      (error: Error) => {
        callback(error);
      },
    );
  }

  private async sendWrite(chunk: Buffer, eof: boolean, writeId: string, attempt: number): Promise<void> {
    const result = (await this.connection.call(PROCESS_WRITE_METHOD, {
      processId: this.processId,
      chunkBase64: chunk.toString('base64'),
      writeId,
      eof: eof || undefined,
    })) as ProcessWriteResult;
    switch (result.status) {
      case 'accepted':
        return;
      case 'starting': {
        if (attempt >= 100) {
          throw new Error('process did not reach running state');
        }
        await delay(50);
        return this.sendWrite(chunk, eof, writeId, attempt + 1);
      }
      // The process is gone or its stdin is closed: the bytes have nowhere to
      // go, so the write becomes a no-op instead of an EPIPE-style crash.
      case 'stdinClosed':
      case 'unknownProcess':
        return;
    }
  }

  onOutput(stream: ProcessOutputStream, chunk: Uint8Array): void {
    if (stream === 'stderr' && this.stderr !== this.stdout) {
      (this.stderr as PushReadable).push(Buffer.from(chunk));
      return;
    }
    (this.stdout as PushReadable).push(Buffer.from(chunk));
  }

  onExited(exitCode: number): void {
    if (this.currentExitCode !== null) return;
    this.currentExitCode = exitCode;
    this.resolveExit(exitCode);
  }

  onClosed(): void {
    (this.stdout as PushReadable).endStream();
    if (this.stderr !== this.stdout) {
      (this.stderr as PushReadable).endStream();
    }
  }

  onConnectionClose(): void {
    if (this.currentExitCode === null) {
      this.currentExitCode = -1;
      this.resolveExit(-1);
    }
    this.onClosed();
  }

  async wait(): Promise<number> {
    return this.exitPromise;
  }

  async kill(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const kind =
      signal === 'SIGINT'
        ? 'interrupt'
        : signal === 'SIGTERM'
          ? 'terminate'
          : signal === 'SIGKILL'
            ? 'kill'
            : undefined;
    if (kind === undefined) {
      throw new HostProcessError(
        HostProcessErrorCode.KillFailed,
        `unsupported signal for a remote process: ${signal}`,
      );
    }
    await this.connection.call(PROCESS_SIGNAL_METHOD, {
      processId: this.processId,
      signal: kind,
    });
  }

  dispose(): void {
    this.stdin.destroy();
    this.stdout.destroy();
    if (this.stderr !== this.stdout) {
      this.stderr.destroy();
    }
  }
}

export class RemoteProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  private readonly processes = new Map<string, RemoteProcess>();

  constructor(
    private readonly connection: RemoteExecConnection,
    private readonly defaultCwd: string,
    private readonly shellPath: string,
  ) {
    connection.onNotification(PROCESS_OUTPUT_METHOD, (params) => {
      const notification = params as ProcessOutputNotification;
      this.processes
        .get(notification.processId)
        ?.onOutput(notification.stream, decodeChunk(notification.chunkBase64));
    });
    connection.onNotification(PROCESS_EXITED_METHOD, (params) => {
      const notification = params as ProcessExitedNotification;
      this.processes.get(notification.processId)?.onExited(notification.exitCode);
    });
    connection.onNotification(PROCESS_CLOSED_METHOD, (params) => {
      const notification = params as ProcessClosedNotification;
      const proc = this.processes.get(notification.processId);
      if (proc === undefined) return;
      proc.onClosed();
      this.processes.delete(notification.processId);
    });
    connection.onDidClose(() => {
      for (const proc of this.processes.values()) {
        proc.onConnectionClose();
      }
    });
  }

  async spawn(
    command: string,
    args: readonly string[] = [],
    options: HostProcessOptions = {},
  ): Promise<IHostProcess> {
    const argv =
      options.shell === undefined
        ? [command, ...args]
        : [
            options.shell === true ? this.shellPath : options.shell,
            '-c',
            [command, ...args].join(' '),
          ];
    const processId = randomUUID();
    const proc = new RemoteProcess(this.connection, processId, options.mergeStderr ?? false);
    this.processes.set(processId, proc);
    try {
      const result = (await this.connection.call(PROCESS_START_METHOD, {
        processId,
        argv,
        cwd: options.cwd ?? this.defaultCwd,
        env: options.env,
        pipeStdin: true,
      })) as ProcessStartResult;
      proc.attach(result.pid);
      return proc;
    } catch (error) {
      this.processes.delete(processId);
      if (error instanceof ConnectionClosedError) {
        proc.onConnectionClose();
      }
      throw toRemoteProcessError(error);
    }
  }
}

function decodeChunk(chunkBase64: string): Uint8Array {
  return new Uint8Array(Buffer.from(chunkBase64, 'base64'));
}

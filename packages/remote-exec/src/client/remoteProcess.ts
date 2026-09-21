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
  PROCESS_FLOW_CAPABILITY,
  PROCESS_FLOW_METHOD,
  PROCESS_OUTPUT_METHOD,
  PROCESS_SIGNAL_METHOD,
  PROCESS_START_METHOD,
  PROCESS_TERMINATE_METHOD,
  PROCESS_WRITE_METHOD,
  type ProcessClosedNotification,
  type ProcessExitedNotification,
  type ProcessOutputNotification,
  type ProcessOutputStream,
  type ProcessStartResult,
  type ProcessWriteResult,
} from '#/protocol/methods';
import { ConnectionClosedError, RequestTimeoutError, type RemoteExecConnection } from './connection';

const HOST_PROCESS_CODES: ReadonlySet<string> = new Set(Object.values(OsProcessErrors.codes));

const WRITE_TIMEOUT_RETRIES = 2;
// Bounded per-stream output buffer: once the consumer falls this far behind,
// the client asks the executor to pause the child's streams (process/flow)
// instead of buffering without limit.
const OUTPUT_BUFFER_BYTES = 256 * 1024;

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
  private stalled = false;

  constructor(private readonly onStallChange: (stalled: boolean) => void) {
    super({ highWaterMark: OUTPUT_BUFFER_BYTES });
  }

  override _read(): void {
    this.setStalled(false);
  }

  pushChunk(chunk: Buffer): void {
    // push() returns false once the internal buffer reaches the high-water
    // mark: report the stall so the executor pauses the child's streams until
    // the consumer catches up (_read) or the stream ends.
    if (this.push(chunk)) return;
    this.setStalled(true);
  }

  endStream(): void {
    this.push(null);
    this.setStalled(false);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.setStalled(false);
    callback(error);
  }

  private setStalled(stalled: boolean): void {
    if (this.stalled === stalled) return;
    this.stalled = stalled;
    this.onStallChange(stalled);
  }
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
  private stdoutStalled = false;
  private stderrStalled = false;
  private outputFlowPaused = false;

  constructor(
    private readonly connection: RemoteExecConnection,
    private readonly processId: string,
    mergeStderr: boolean,
  ) {
    this.stdout = new PushReadable((stalled) => {
      this.stdoutStalled = stalled;
      this.updateOutputFlow();
    });
    this.stderr = mergeStderr
      ? this.stdout
      : new PushReadable((stalled) => {
          this.stderrStalled = stalled;
          this.updateOutputFlow();
        });
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
    const run = this.writeChain.then(() => this.sendWriteWithRetry(chunk, eof, writeId));
    // The chain itself always settles: one failed write reports through the
    // callback (which errors this Writable) but must not poison every later
    // queued write with the same rejection.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    run.then(
      () => {
        callback();
      },
      (error: Error) => {
        callback(error);
      },
    );
  }

  private async sendWriteWithRetry(chunk: Buffer, eof: boolean, writeId: string): Promise<void> {
    for (let timeouts = 0; ; timeouts += 1) {
      try {
        await this.sendWrite(chunk, eof, writeId);
        return;
      } catch (error) {
        // A timed-out write may or may not have landed; replaying the same
        // writeId is safe because the server dedups accepted write ids.
        if (!(error instanceof RequestTimeoutError) || timeouts >= WRITE_TIMEOUT_RETRIES) {
          throw error;
        }
      }
    }
  }

  private async sendWrite(chunk: Buffer, eof: boolean, writeId: string): Promise<void> {
    const result = (await this.connection.call(PROCESS_WRITE_METHOD, {
      processId: this.processId,
      chunkBase64: chunk.toString('base64'),
      writeId,
      eof: eof || undefined,
    })) as ProcessWriteResult;
    switch (result.status) {
      case 'accepted':
        return;
      case 'starting':
        throw new Error('process did not reach running state');
      // The process is gone or its stdin is closed: the bytes have nowhere to
      // go, so the write becomes a no-op instead of an EPIPE-style crash.
      case 'stdinClosed':
      case 'unknownProcess':
        return;
    }
  }

  onOutput(stream: ProcessOutputStream, chunk: Uint8Array): void {
    if (stream === 'stderr' && this.stderr !== this.stdout) {
      (this.stderr as PushReadable).pushChunk(Buffer.from(chunk));
      return;
    }
    (this.stdout as PushReadable).pushChunk(Buffer.from(chunk));
  }

  private updateOutputFlow(): void {
    const stalled = this.stdoutStalled || this.stderrStalled;
    if (stalled === this.outputFlowPaused) return;
    // Only executors that advertise the capability honor process/flow — older
    // ones fault unknown notifications, so an unadvertised stall just buffers.
    if (this.connection.capabilities[PROCESS_FLOW_CAPABILITY] !== true) return;
    this.outputFlowPaused = stalled;
    // Per-process flow control: the executor pauses just this child's
    // stdout/stderr while the consumer is behind, so an unread flood stays
    // bounded end to end without blocking the connection's other traffic
    // (call responses included — pausing the whole pipe would deadlock the
    // stdin write chain against its own responses).
    this.connection.notify(PROCESS_FLOW_METHOD, { processId: this.processId, paused: stalled });
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
      if (error instanceof RequestTimeoutError) {
        // The server may still be spawning behind the timed-out request:
        // cancel the late start so the child does not become an orphan
        // without a handle. terminate is idempotent (terminateAfterStart
        // covers an in-flight spawn) and best-effort here.
        void this.connection.call(PROCESS_TERMINATE_METHOD, { processId }).catch(() => {});
      }
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

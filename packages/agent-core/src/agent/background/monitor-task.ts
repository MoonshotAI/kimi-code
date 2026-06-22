import type { KaosProcess } from '@moonshot-ai/kaos';
import type { Readable } from 'node:stream';

import { errorMessage } from '../../loop/errors';
import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
  BackgroundTaskSettlement,
  MonitorBackgroundTaskInfo,
} from './task';

export type MonitorEmit = (lines: string[], severity?: 'info' | 'warning') => void;

export interface MonitorOptions {
  /** Debounce window for batching lines before emitting. */
  readonly batchMs?: number;
  /** Maximum complete lines allowed inside the volume window. */
  readonly maxLinesPerWindow?: number;
  /** Length of the sliding volume window in milliseconds. */
  readonly volumeWindowMs?: number;
}

const DEFAULT_BATCH_MS = 200;
const DEFAULT_MAX_LINES_PER_WINDOW = 200;
const DEFAULT_VOLUME_WINDOW_MS = 5000;
const STREAM_DRAIN_GRACE_MS = 250;

export class MonitorBackgroundTask implements BackgroundTask {
  readonly kind = 'monitor' as const;
  readonly idPrefix = 'monitor';

  private exitCode: number | null = null;
  private pending = '';
  private batch: string[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private volumeWindowStart = 0;
  private volumeCount = 0;
  private capped = false;

  constructor(
    readonly proc: KaosProcess,
    readonly command: string,
    readonly description: string,
    private readonly emit: MonitorEmit,
    private readonly options: MonitorOptions = {},
    readonly timeoutMs?: number,
  ) {}

  async start(sink: BackgroundTaskSink): Promise<void> {
    const stdoutDrained = observeMonitorStream(this.proc.stdout, sink, (chunk) =>
      this.feed(chunk),
    );
    const streamDrained = Promise.all([
      stdoutDrained,
      observeMonitorStream(this.proc.stderr, sink),
    ]).then(() => undefined);
    // Attach a rejection handler immediately; start() still awaits the same
    // promise after proc.wait() so stream errors keep failing the task.
    void streamDrained.catch(() => {});

    const requestStop = (): void => {
      void this.proc.kill('SIGTERM').catch(() => {});
    };
    if (sink.signal.aborted) {
      requestStop();
    } else {
      sink.signal.addEventListener('abort', requestStop, { once: true });
    }

    let settlement: BackgroundTaskSettlement;
    try {
      const exitCode = await this.proc.wait();
      await waitForStreamDrain(streamDrained);
      this.exitCode = exitCode;
      settlement = {
        status: sink.signal.aborted ? 'killed' : exitCode === 0 ? 'completed' : 'failed',
      };
    } catch (error: unknown) {
      await waitForStreamDrainSettled(streamDrained);
      this.exitCode = this.proc.exitCode;
      settlement = {
        status: sink.signal.aborted ? 'killed' : 'failed',
        stopReason: sink.signal.aborted ? undefined : errorMessage(error),
      };
    } finally {
      sink.signal.removeEventListener('abort', requestStop);
      this.flushBatch(true);
      this.clearBatchTimer();
      await this.disposeProcess();
    }
    await sink.settle(settlement);
  }

  async forceStop(): Promise<void> {
    try {
      if (this.proc.exitCode === null) {
        await this.proc.kill('SIGKILL');
      }
    } finally {
      this.clearBatchTimer();
      await this.disposeProcess();
    }
  }

  toInfo(base: BackgroundTaskInfoBase): MonitorBackgroundTaskInfo {
    return {
      ...base,
      kind: 'monitor',
      command: this.command,
    };
  }

  private feed(chunk: string): void {
    if (this.capped) return;
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    for (const line of parts) {
      this.batch.push(line);
      this.checkVolume(line);
      if (this.capped) break;
    }
    this.scheduleBatchFlush();
  }

  private checkVolume(line: string): void {
    const now = Date.now();
    const windowMs = this.options.volumeWindowMs ?? DEFAULT_VOLUME_WINDOW_MS;
    if (now - this.volumeWindowStart > windowMs) {
      this.volumeWindowStart = now;
      this.volumeCount = 0;
    }
    this.volumeCount += 1;
    const maxLines = this.options.maxLinesPerWindow ?? DEFAULT_MAX_LINES_PER_WINDOW;
    if (this.volumeCount > maxLines) {
      this.capped = true;
      void this.forceStop().catch(() => {});
      this.emit(
        [
          `Monitor auto-stopped: too noisy (>${String(maxLines)} lines / ${String(windowMs / 1000)}s). Restart with a tighter filter.`,
        ],
        'warning',
      );
    }
  }

  private scheduleBatchFlush(): void {
    this.clearBatchTimer();
    if (this.batch.length === 0) return;
    this.batchTimer = setTimeout(
      () => this.flushBatch(false),
      this.options.batchMs ?? DEFAULT_BATCH_MS,
    );
    this.batchTimer.unref?.();
  }

  private flushBatch(terminal: boolean): void {
    this.clearBatchTimer();
    if (this.batch.length > 0) {
      this.emit(this.batch);
      this.batch = [];
    }
    if (terminal && this.pending.length > 0 && !this.capped) {
      this.emit([this.pending]);
      this.pending = '';
    }
  }

  private clearBatchTimer(): void {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
  }

  private async disposeProcess(): Promise<void> {
    try {
      await this.proc.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function waitForStreamDrain(streamDrained: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      streamDrained,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, STREAM_DRAIN_GRACE_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForStreamDrainSettled(streamDrained: Promise<void>): Promise<void> {
  try {
    await waitForStreamDrain(streamDrained);
  } catch {
    /* original process/stream error wins */
  }
}

function observeMonitorStream(
  stream: Readable,
  sink: BackgroundTaskSink,
  onOutput?: (chunk: string) => void,
): Promise<void> {
  stream.setEncoding('utf8');
  const onData = (chunk: string): void => {
    if (chunk.length === 0) return;
    sink.appendOutput(chunk);
    onOutput?.(chunk);
  };
  stream.on('data', onData);

  return new Promise<void>((resolve, reject) => {
    let ended = false;
    const settle = (callback: () => void): void => {
      cleanup();
      callback();
    };
    const done = (): void => {
      settle(resolve);
    };
    const fail = (error: unknown): void => {
      settle(() => reject(error));
    };
    const onEnd = (): void => {
      ended = true;
      done();
    };
    const onClose = (): void => {
      if (ended || sink.signal.aborted) {
        done();
        return;
      }
      fail(createPrematureCloseError());
    };
    const onError = (error: Error): void => {
      // When the task is aborted we intentionally destroy the streams, which
      // can emit errors. Swallow those expected errors; surface anything else.
      if (sink.signal.aborted) {
        done();
      } else {
        fail(error);
      }
    };
    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    };
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
  });
}

function createPrematureCloseError(): Error {
  const error = new Error('Premature close') as NodeJS.ErrnoException;
  error.code = 'ERR_STREAM_PREMATURE_CLOSE';
  return error;
}

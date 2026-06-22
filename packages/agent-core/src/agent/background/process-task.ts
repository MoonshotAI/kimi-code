import type { KaosProcess } from '@moonshot-ai/kaos';
import type { Readable } from 'node:stream';

import { errorMessage } from '../../loop/errors';
import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
  BackgroundTaskSettlement,
} from './task';

export interface ProcessBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export type ProcessBackgroundTaskOutputKind = 'stdout' | 'stderr';

export type ProcessBackgroundTaskOutputCallback = (
  kind: ProcessBackgroundTaskOutputKind,
  text: string,
) => void;

const STREAM_DRAIN_GRACE_MS = 250;

export class ProcessBackgroundTask implements BackgroundTask {
  readonly kind = 'process' as const;
  readonly idPrefix = 'bash';
  private exitCode: number | null = null;

  constructor(
    readonly proc: KaosProcess,
    readonly command: string,
    readonly description: string,
    private readonly onOutput?: ProcessBackgroundTaskOutputCallback,
  ) {}

  async start(sink: BackgroundTaskSink): Promise<void> {
    const streamDrained = Promise.all([
      observeProcessStream(this.proc.stdout, 'stdout', sink, this.onOutput),
      observeProcessStream(this.proc.stderr, 'stderr', sink, this.onOutput),
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
      await this.disposeProcess();
    }
  }

  toInfo(base: BackgroundTaskInfoBase): ProcessBackgroundTaskInfo {
    return {
      ...base,
      kind: 'process',
      command: this.command,
      pid: this.proc.pid,
      exitCode: this.exitCode,
    };
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

function observeProcessStream(
  stream: Readable,
  kind: ProcessBackgroundTaskOutputKind,
  sink: BackgroundTaskSink,
  onOutput?: ProcessBackgroundTaskOutputCallback,
): Promise<void> {
  stream.setEncoding('utf8');
  const onData = (chunk: string): void => {
    if (chunk.length === 0) return;
    sink.appendOutput(chunk);
    onOutput?.(kind, chunk);
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

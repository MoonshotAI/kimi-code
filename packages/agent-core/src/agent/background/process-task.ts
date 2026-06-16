import type { KaosProcess } from '@moonshot-ai/kaos';
import type { Readable } from 'node:stream';

import { errorMessage } from '../../loop/errors';
import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
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
    const streamSettled = [
      observeProcessStream(this.proc.stdout, 'stdout', sink, this.onOutput),
      observeProcessStream(this.proc.stderr, 'stderr', sink, this.onOutput),
    ];

    const requestStop = (): void => {
      void this.proc.kill('SIGTERM').catch(() => {});
      destroyProcessStreams(this.proc);
    };
    if (sink.signal.aborted) {
      requestStop();
    } else {
      sink.signal.addEventListener('abort', requestStop, { once: true });
    }

    try {
      const exitCode = await this.proc.wait();
      await Promise.all(streamSettled);
      this.exitCode = exitCode;
      await sink.settle({
        status: sink.signal.aborted ? 'killed' : exitCode === 0 ? 'completed' : 'failed',
      });
    } catch (error: unknown) {
      await Promise.allSettled(streamSettled);
      this.exitCode = this.proc.exitCode;
      await sink.settle({
        status: sink.signal.aborted ? 'killed' : 'failed',
        stopReason: sink.signal.aborted ? undefined : errorMessage(error),
      });
    } finally {
      sink.signal.removeEventListener('abort', requestStop);
    }
  }

  async forceStop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    await this.proc.kill('SIGKILL');
    destroyProcessStreams(this.proc);
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
}

function destroyProcessStreams(proc: KaosProcess): void {
  try {
    proc.stdout.destroy();
  } catch {
    /* ignore */
  }
  try {
    proc.stderr.destroy();
  } catch {
    /* ignore */
  }
}

function observeProcessStream(
  stream: Readable,
  kind: ProcessBackgroundTaskOutputKind,
  sink: BackgroundTaskSink,
  onOutput?: ProcessBackgroundTaskOutputCallback,
): Promise<void> {
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    if (chunk.length === 0) return;
    sink.appendOutput(chunk);
    onOutput?.(kind, chunk);
  });

  return new Promise<void>((resolve) => {
    const done = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      stream.removeListener('end', done);
      stream.removeListener('close', done);
      stream.removeListener('error', done);
    };
    stream.once('end', done);
    stream.once('close', done);
    stream.once('error', done);
  });
}

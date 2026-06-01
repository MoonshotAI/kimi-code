import type { KaosProcess } from '@moonshot-ai/kaos';

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

export interface ProcessBackgroundTaskOptions {
  readonly idPrefix?: string;
}

export class ProcessBackgroundTask implements BackgroundTask {
  readonly kind = 'process' as const;
  readonly idPrefix: string;
  private exitCode: number | null = null;

  constructor(
    readonly proc: KaosProcess,
    readonly command: string,
    readonly description: string,
    options: ProcessBackgroundTaskOptions = {},
  ) {
    this.idPrefix = options.idPrefix ?? 'bash';
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    for (const stream of [this.proc.stdout, this.proc.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        sink.appendOutput(chunk);
      });
    }

    const requestStop = (): void => {
      void this.proc.kill('SIGTERM').catch(() => {});
    };
    if (sink.signal.aborted) {
      requestStop();
    } else {
      sink.signal.addEventListener('abort', requestStop, { once: true });
    }

    try {
      const exitCode = await this.proc.wait();
      this.exitCode = exitCode;
      await sink.settle({
        status: sink.signal.aborted ? 'killed' : exitCode === 0 ? 'completed' : 'failed',
      });
    } catch (error: unknown) {
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

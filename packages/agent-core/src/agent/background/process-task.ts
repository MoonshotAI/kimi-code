import type { KaosProcess } from '@moonshot-ai/kaos';

import { errorMessage } from '../../loop/errors';
import type {
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
} from './task';

export class ProcessBackgroundTask implements BackgroundTask {
  readonly kind = 'process' as const;
  readonly idPrefix = 'bash';
  private exitCode: number | null = null;

  constructor(
    readonly proc: KaosProcess,
    readonly command: string,
    readonly description: string,
  ) {}

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

  toInfo(base: BackgroundTaskInfoBase): BackgroundTaskInfo {
    return {
      ...base,
      kind: 'process',
      command: this.command,
      pid: this.proc.pid,
      exitCode: this.exitCode,
    };
  }
}

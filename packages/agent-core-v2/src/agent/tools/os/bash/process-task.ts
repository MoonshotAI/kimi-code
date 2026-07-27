import type { Readable } from 'node:stream';

import type { IProcess } from '#/session/process/processRunner';

import type {
  AgentTask,
  AgentTaskInfoBase,
  AgentTaskSink,
  AgentTaskSettlement,
} from '#/agent/task/types';

export interface ProcessTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

declare module '#/agent/task/types' {
  interface AgentTaskInfoByKind {
    readonly process: ProcessTaskInfo;
  }
}

export type ProcessTaskOutputKind = 'stdout' | 'stderr';

export type ProcessTaskOutputCallback = (
  kind: ProcessTaskOutputKind,
  text: string,
) => void;

const STREAM_DRAIN_GRACE_MS = 250;

export class ProcessTask implements AgentTask {
  readonly kind = 'process' as const;
  readonly idPrefix = 'bash';
  private exitCode: number | null = null;

  constructor(
    readonly proc: IProcess,
    readonly command: string,
    readonly description: string,
    private readonly onOutput?: ProcessTaskOutputCallback,
  ) {}

  async start(sink: AgentTaskSink): Promise<void> {
    const streamDrained = Promise.all([
      observeProcessStream(this.proc.stdout, 'stdout', sink, this.onOutput),
      observeProcessStream(this.proc.stderr, 'stderr', sink, this.onOutput),
    ]).then(() => undefined);
    void streamDrained.catch(() => {});

    const requestStop = (): void => {
      void this.proc.kill('SIGTERM').catch(() => {});
    };
    if (sink.signal.aborted) {
      requestStop();
    } else {
      sink.signal.addEventListener('abort', requestStop, { once: true });
    }

    let settlement: AgentTaskSettlement;
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

  toInfo(base: AgentTaskInfoBase): ProcessTaskInfo {
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
  }
}

function observeProcessStream(
  stream: Readable,
  kind: ProcessTaskOutputKind,
  sink: AgentTaskSink,
  onOutput?: ProcessTaskOutputCallback,
): Promise<void> {
  stream.setEncoding('utf8');
  const onData = (chunk: string): void => {
    if (chunk.length === 0) return;
    sink.appendOutput(chunk);
    if (sink.signal.aborted) return;
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

export interface ProcessTaskResult {
  readonly exitCode: number | null;
}

export function createProcessExecutor(
  proc: IProcess,
  onOutput?: ProcessTaskOutputCallback,
): (signal: AbortSignal, output: (data: string) => void) => Promise<ProcessTaskResult> {
  return async (signal, output) => {
    const forwardOutput = (chunk: string, kind: ProcessTaskOutputKind): void => {
      if (chunk.length === 0) return;
      output(chunk);
      if (signal.aborted) return;
      onOutput?.(kind, chunk);
    };

    const streamDrained = Promise.all([
      observeProcessStreamRaw(proc.stdout, 'stdout', signal, forwardOutput),
      observeProcessStreamRaw(proc.stderr, 'stderr', signal, forwardOutput),
    ]).then(() => undefined);
    void streamDrained.catch(() => {});

    const requestStop = (): void => {
      void proc.kill('SIGTERM').catch(() => {});
    };
    if (signal.aborted) {
      requestStop();
    } else {
      signal.addEventListener('abort', requestStop, { once: true });
    }

    try {
      const exitCode = await proc.wait();
      await waitForStreamDrain(streamDrained);
      signal.removeEventListener('abort', requestStop);
      await disposeProcess(proc);
      if (signal.aborted) throw signal.reason;
      if (exitCode !== 0) {
        const err = new ProcessExitError(exitCode);
        throw err;
      }
      return { exitCode };
    } catch (error: unknown) {
      await waitForStreamDrainSettled(streamDrained);
      signal.removeEventListener('abort', requestStop);
      await disposeProcess(proc);
      throw error;
    }
  };
}

export class ProcessExitError extends Error {
  constructor(readonly exitCode: number | null) {
    super(`Process exited with code ${exitCode}`);
    this.name = 'ProcessExitError';
  }
}

function observeProcessStreamRaw(
  stream: Readable,
  kind: ProcessTaskOutputKind,
  signal: AbortSignal,
  onChunk: (chunk: string, kind: ProcessTaskOutputKind) => void,
): Promise<void> {
  stream.setEncoding('utf8');
  const onData = (chunk: string): void => {
    onChunk(chunk, kind);
  };
  stream.on('data', onData);

  return new Promise<void>((resolve, reject) => {
    let ended = false;
    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    };
    const done = (): void => { cleanup(); resolve(); };
    const fail = (error: unknown): void => { cleanup(); reject(error); };
    const onEnd = (): void => { ended = true; done(); };
    const onClose = (): void => {
      if (ended || signal.aborted) { done(); return; }
      fail(createPrematureCloseError());
    };
    const onError = (error: Error): void => {
      if (signal.aborted) { done(); } else { fail(error); }
    };
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
  });
}

async function disposeProcess(proc: IProcess): Promise<void> {
  try { await proc.dispose(); } catch {   }
}

function createPrematureCloseError(): Error {
  const error = new Error('Premature close') as NodeJS.ErrnoException;
  error.code = 'ERR_STREAM_PREMATURE_CLOSE';
  return error;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import type { OsProcess } from './host/types';

export type ProcessOutputKind = 'stdout' | 'stderr';

export type ProcessOutputCallback = (kind: ProcessOutputKind, text: string) => void;

export type ProcessExecutionStatus = 'completed' | 'failed' | 'killed';

export interface ProcessSettlement {
  readonly status: ProcessExecutionStatus;
  readonly exitCode: number | null;
  readonly stopReason?: string;
}

export interface ProcessExecution {
  readonly done: Promise<ProcessSettlement>;
  forceStop(): Promise<void>;
}

export interface StartProcessExecutionOptions {
  readonly signal: AbortSignal;
  readonly onChunk?: ProcessOutputCallback;
  readonly onOutput?: ProcessOutputCallback;
  readonly sigtermGraceMs?: number;
}

export const STREAM_DRAIN_GRACE_MS = 250;
export const SIGTERM_GRACE_MS = 5_000;

function isPrematureCloseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function observeProcessStream(
  stream: AsyncIterable<Uint8Array>,
  kind: ProcessOutputKind,
  signal: AbortSignal,
  options: StartProcessExecutionOptions,
): Promise<void> {
  const decoder = new TextDecoder('utf-8');
  try {
    for await (const bytes of stream) {
      const chunk = decoder.decode(bytes, { stream: true });
      if (chunk.length === 0) continue;
      options.onChunk?.(kind, chunk);
      if (signal.aborted) continue;
      options.onOutput?.(kind, chunk);
    }
    const tail = decoder.decode();
    if (tail.length === 0) return;
    options.onChunk?.(kind, tail);
    if (signal.aborted) return;
    options.onOutput?.(kind, tail);
  } catch (error) {
    if (signal.aborted || isPrematureCloseError(error)) return;
    throw error;
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

function disposeProcess(proc: OsProcess): void {
  try {
    proc.dispose();
  } catch {
  }
}

export function startProcessExecution(
  proc: OsProcess,
  options: StartProcessExecutionOptions,
): ProcessExecution {
  const { signal } = options;

  const start = async (): Promise<ProcessSettlement> => {
    const streamDrained = Promise.all([
      observeProcessStream(proc.stdout, 'stdout', signal, options),
      observeProcessStream(proc.stderr, 'stderr', signal, options),
    ]).then(() => undefined);
    void streamDrained.catch(() => {});

    let forceStopTimer: ReturnType<typeof setTimeout> | undefined;
    const requestStop = (): void => {
      void proc.kill('SIGTERM').catch(() => {});
      forceStopTimer = setTimeout(() => {
        void forceStop().catch(() => {});
      }, options.sigtermGraceMs ?? SIGTERM_GRACE_MS);
      forceStopTimer.unref?.();
    };
    if (signal.aborted) {
      requestStop();
    } else {
      signal.addEventListener('abort', requestStop, { once: true });
    }

    try {
      const exitCode = await proc.wait();
      await waitForStreamDrain(streamDrained);
      return {
        status: signal.aborted ? 'killed' : exitCode === 0 ? 'completed' : 'failed',
        exitCode,
      };
    } catch (error: unknown) {
      await waitForStreamDrainSettled(streamDrained);
      return {
        status: signal.aborted ? 'killed' : 'failed',
        exitCode: proc.exitCode,
        stopReason: signal.aborted ? undefined : errorMessage(error),
      };
    } finally {
      if (forceStopTimer !== undefined) clearTimeout(forceStopTimer);
      signal.removeEventListener('abort', requestStop);
      disposeProcess(proc);
    }
  };

  const forceStop = async (): Promise<void> => {
    try {
      if (proc.exitCode === null) {
        await proc.kill('SIGKILL');
      }
    } finally {
      disposeProcess(proc);
    }
  };

  return { done: start(), forceStop };
}

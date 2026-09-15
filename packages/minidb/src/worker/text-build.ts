// Main-thread hosting for the bounded text build. A worker must complete the
// versioned ready handshake before failures are treated as build failures;
// constructor/bootstrap failures safely retry the same task through the inline
// bounded core, while crashes after ready remain fatal. Every terminal path
// waits for the worker's exit before settling or starting an inline fallback.

import fsSync from 'node:fs';
import { Worker } from 'node:worker_threads';
import { crc32 } from '../crc32.ts';
import {
  getTextBuildWorkerRuntimeState,
  TEXT_BUILD_WORKER_PROTOCOL_VERSION,
  type TextBuildWorkerRuntimeEntry,
} from '../worker-runtime.ts';
import { buildTextArtifacts } from './text-build-core.ts';
import type { TextBuildCoreResult, TextBuildCoreSpec } from './text-build-core.ts';

export type WorkerTextBuildFallbackReason =
  | 'runtime-unavailable'
  | 'slot-pressure'
  | 'disabled'
  | 'constructor-failure'
  | 'bootstrap-failure'
  | 'protocol-mismatch';

export interface WorkerTextBuildHandle {
  readonly promise: Promise<TextBuildCoreResult>;
  cancel(): Promise<void>;
  readonly worker: Worker | null;
  readonly inline: boolean;
  readonly fallbackReason: WorkerTextBuildFallbackReason | null;
}

export interface TextBuildCheckpoint {
  walOffset: number;
  walDev: number;
  walIno: number;
  snapshotDev: number;
  snapshotIno: number;
}

export interface WorkerTextBuildOptions {
  signal?: AbortSignal;
  shouldAbort?: () => boolean;
  abortPollMs?: number;
  workerMaxOldSpaceMb?: number;
  inline?: boolean;
  inlineReason?: WorkerTextBuildFallbackReason;
  workerFactory?: (spec: TextBuildCoreSpec) => Worker;
  onProgress?: (p: { docs: number; terms: number; segments: number }) => void;
  onFallback?: (reason: WorkerTextBuildFallbackReason) => void;
}

export class WorkerTextBuildError extends Error {
  readonly code = 'WORKER_TEXT_BUILD_FAILED';
  readonly aborted: boolean;
  constructor(message: string, aborted = false) {
    super(message);
    this.name = aborted ? 'AbortError' : 'WorkerTextBuildError';
    this.aborted = aborted;
  }
}

const DEFAULT_ABORT_POLL_MS = 100;
const DEFAULT_MAX_OLD_SPACE_MB = 1024;

export async function verifyFileCrcAsync(
  filePath: string,
  expected: { bytes: number; crc32: number },
): Promise<void> {
  const fh = await import('node:fs/promises').then((m) => m.open(filePath, 'r'));
  try {
    const st = await fh.stat();
    if (st.size !== expected.bytes) {
      throw new Error(`worker artifact ${filePath}: size ${st.size} != manifest ${expected.bytes}`);
    }
    let crc = 0;
    const buf = Buffer.allocUnsafe(1 << 20);
    let pos = 0;
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (bytesRead === 0) throw new Error(`worker artifact ${filePath}: shrank during verification`);
      crc = crc32(buf.subarray(0, bytesRead), crc);
      pos += bytesRead;
    }
    if ((crc >>> 0) !== expected.crc32) {
      throw new Error(`worker artifact ${filePath}: crc mismatch`);
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

function siblingWorkerEntry(): TextBuildWorkerRuntimeEntry | null {
  const url = new URL('./text-build-worker.ts', import.meta.url);
  try {
    return fsSync.statSync(url).isFile() ? { kind: 'source', url } : null;
  } catch {
    return null;
  }
}

function workerRuntimeEntry(): TextBuildWorkerRuntimeEntry | null {
  const state = getTextBuildWorkerRuntimeState();
  return state.configured ? state.entry : siblingWorkerEntry();
}

export function textBuildWorkerAvailable(): boolean {
  return workerRuntimeEntry() !== null;
}

function spawnWorker(
  spec: TextBuildCoreSpec,
  opts: WorkerTextBuildOptions,
  entry: TextBuildWorkerRuntimeEntry,
): Worker {
  const resourceLimits = {
    maxOldGenerationSizeMb: opts.workerMaxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB,
  };
  if (entry.kind === 'packaged') {
    return new Worker(entry.path, { workerData: spec, execArgv: [], resourceLimits });
  }
  return new Worker(entry.url, {
    workerData: spec,
    // --experimental-transform-types runs the TS worker source directly in dev;
    // silence its experimental warning so it does not bleed into the TUI.
    execArgv: ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'],
    resourceLimits,
  });
}

type WorkerMessage = {
  type: string;
  version?: number;
  result?: TextBuildCoreResult;
  error?: string;
  aborted?: boolean;
  docs?: number;
  terms?: number;
  segments?: number;
};

type WorkerEvent =
  | { type: 'message'; message: WorkerMessage }
  | { type: 'error'; error: Error }
  | { type: 'exit'; code: number };

export function startWorkerTextBuild(
  spec: TextBuildCoreSpec,
  opts: WorkerTextBuildOptions = {},
): WorkerTextBuildHandle {
  if (opts.inline) {
    return startInline(spec, opts, opts.inlineReason ?? 'disabled');
  }

  const entry = workerRuntimeEntry();
  if (entry === null && opts.workerFactory === undefined) {
    return startInline(spec, opts, 'runtime-unavailable');
  }

  let activeWorker: Worker;
  try {
    activeWorker = opts.workerFactory?.(spec) ?? spawnWorker(spec, opts, entry!);
  } catch {
    return startInline(spec, opts, 'constructor-failure');
  }

  let worker: Worker | null = activeWorker;
  let inline = false;
  let fallbackReason: WorkerTextBuildFallbackReason | null = null;
  let inlineHandle: WorkerTextBuildHandle | null = null;
  let cancelRequested = false;
  let completed = false;
  let abortPoll: ReturnType<typeof setInterval> | null = null;
  let onOwnerAbort: (() => void) | null = null;
  let terminateTimer: ReturnType<typeof setTimeout> | null = null;
  let terminatePromise: Promise<number> | null = null;
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const events: WorkerEvent[] = [];
  let eventWaiter: ((event: WorkerEvent) => void) | null = null;
  const pushEvent = (event: WorkerEvent): void => {
    if (eventWaiter !== null) {
      const resolve = eventWaiter;
      eventWaiter = null;
      resolve(event);
    } else {
      events.push(event);
    }
  };
  const nextEvent = (): Promise<WorkerEvent> => {
    const event = events.shift();
    if (event !== undefined) return Promise.resolve(event);
    return new Promise((resolve) => {
      eventWaiter = resolve;
    });
  };

  const onMessage = (message: WorkerMessage): void => {
    pushEvent({ type: 'message', message });
  };
  const onError = (error: Error): void => {
    pushEvent({ type: 'error', error });
  };
  const onExit = (code: number): void => {
    exitCode = code;
    worker = null;
    resolveExit(code);
    pushEvent({ type: 'exit', code });
  };
  activeWorker.on('message', onMessage);
  activeWorker.on('error', onError);
  activeWorker.on('exit', onExit);

  const stopWorker = async (): Promise<number> => {
    if (exitCode !== null) return exitCode;
    if (terminatePromise === null) {
      try {
        terminatePromise = activeWorker.terminate();
      } catch (error) {
        terminatePromise = Promise.reject(error);
      }
    }
    let terminateError: unknown;
    try {
      await terminatePromise;
    } catch (error) {
      terminateError = error;
    }
    const confirmedExitCode = await exitPromise;
    if (terminateError !== undefined) {
      throw terminateError instanceof Error
        ? terminateError
        : new Error('text build worker termination failed', { cause: terminateError });
    }
    return confirmedExitCode;
  };

  const cleanup = (): void => {
    if (abortPoll !== null) clearInterval(abortPoll);
    abortPoll = null;
    if (opts.signal && onOwnerAbort) opts.signal.removeEventListener('abort', onOwnerAbort);
    if (terminateTimer !== null) clearTimeout(terminateTimer);
    terminateTimer = null;
    activeWorker.off('message', onMessage);
    activeWorker.off('error', onError);
    activeWorker.off('exit', onExit);
  };

  const abortError = (): WorkerTextBuildError =>
    new WorkerTextBuildError('text build worker was cancelled', true);

  const startFallback = async (
    reason: WorkerTextBuildFallbackReason,
  ): Promise<TextBuildCoreResult> => {
    await stopWorker();
    if (cancelRequested) throw abortError();
    inline = true;
    fallbackReason = reason;
    opts.onFallback?.(reason);
    inlineHandle = startInline(spec, { ...opts, onFallback: undefined }, null);
    if (cancelRequested) await inlineHandle.cancel();
    return inlineHandle.promise;
  };

  const run = async (): Promise<TextBuildCoreResult> => {
    let ready = false;
    while (true) {
      const event = await nextEvent();
      if (event.type === 'message') {
        const message = event.message;
        if (message.type === 'ready') {
          if (message.version !== TEXT_BUILD_WORKER_PROTOCOL_VERSION) {
            return startFallback('protocol-mismatch');
          }
          ready = true;
          continue;
        }
        if (!ready) continue;
        if (message.type === 'progress') {
          opts.onProgress?.({
            docs: message.docs ?? 0,
            terms: message.terms ?? 0,
            segments: message.segments ?? 0,
          });
          continue;
        }
        if (message.type === 'done') {
          await stopWorker();
          if (cancelRequested) throw abortError();
          return message.result!;
        }
        if (message.type === 'failed') {
          await stopWorker();
          throw new WorkerTextBuildError(
            message.error ?? 'text build failed in the worker',
            message.aborted ?? cancelRequested,
          );
        }
        continue;
      }

      if (event.type === 'error') {
        await stopWorker();
        if (!ready && !cancelRequested) return startFallback('bootstrap-failure');
        throw new WorkerTextBuildError(
          `text build worker errored: ${event.error.message}`,
          cancelRequested,
        );
      }

      if (!ready && !cancelRequested) return startFallback('bootstrap-failure');
      throw new WorkerTextBuildError(
        `text build worker exited early (code ${event.code})`,
        cancelRequested,
      );
    }
  };

  const promise = run().finally(() => {
    completed = true;
    cleanup();
  });
  promise.catch(() => {});

  const requestCancel = (): void => {
    if (cancelRequested || completed) return;
    cancelRequested = true;
    if (inlineHandle !== null) {
      void inlineHandle.cancel();
      return;
    }
    try {
      activeWorker.postMessage({ type: 'cancel' }, []);
    } catch {
      // The exit/error event drives final settlement.
    }
    terminateTimer = setTimeout(() => {
      void stopWorker().catch(() => {});
    }, 2000);
    terminateTimer.unref?.();
  };

  if (opts.signal) {
    onOwnerAbort = requestCancel;
    if (opts.signal.aborted) requestCancel();
    else opts.signal.addEventListener('abort', onOwnerAbort, { once: true });
  }
  if (opts.shouldAbort) {
    abortPoll = setInterval(() => {
      if (opts.shouldAbort!()) requestCancel();
    }, opts.abortPollMs ?? DEFAULT_ABORT_POLL_MS);
    abortPoll.unref?.();
  }

  return {
    promise,
    cancel: async () => {
      requestCancel();
      await promise.catch(() => {});
      if (worker !== null) await stopWorker();
    },
    get worker() {
      return worker;
    },
    get inline() {
      return inline;
    },
    get fallbackReason() {
      return fallbackReason;
    },
  };
}

function startInline(
  spec: TextBuildCoreSpec,
  opts: WorkerTextBuildOptions,
  reason: WorkerTextBuildFallbackReason | null,
): WorkerTextBuildHandle {
  if (reason !== null) opts.onFallback?.(reason);
  const controller = new AbortController();
  let poll: ReturnType<typeof setInterval> | null = null;
  let onOwnerAbort: (() => void) | null = null;
  if (opts.signal) {
    onOwnerAbort = () => {
      controller.abort();
    };
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onOwnerAbort, { once: true });
  }
  if (opts.shouldAbort) {
    poll = setInterval(() => {
      if (opts.shouldAbort!()) controller.abort();
    }, opts.abortPollMs ?? DEFAULT_ABORT_POLL_MS);
    poll.unref?.();
  }
  const inner: TextBuildCoreSpec = {
    ...spec,
    signal: controller.signal,
    onProgress: opts.onProgress,
  };
  const promise = buildTextArtifacts(inner).finally(() => {
    if (poll !== null) clearInterval(poll);
    if (opts.signal && onOwnerAbort) opts.signal.removeEventListener('abort', onOwnerAbort);
  });
  return {
    promise,
    cancel: async () => {
      controller.abort();
      await promise.catch(() => {});
    },
    worker: null,
    inline: true,
    fallbackReason: reason,
  };
}

/**
 * `fileTools` domain — shared ripgrep subprocess plumbing.
 *
 * Single place that knows how Glob spawns `rg` through the host
 * `IHostProcessService`: timeout / abort handling, capped stdout / stderr
 * draining, two-phase kill with process disposal, and the EAGAIN retry
 * predicate. Mode-specific argument building and output parsing stay in the
 * tools themselves.
 *
 * Ported from `session/sessionFs/runRg` onto the os tools: the subprocess now
 * goes through `IHostProcessService.spawn` instead of the session
 * `ISessionProcessRunner.exec`.
 */

import type { Readable } from 'node:stream';

import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const SIGTERM_GRACE_MS = 5_000;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface RunRgResult {
  readonly kind: 'result';
  readonly exitCode: number;
  readonly stdoutText: string;
  readonly stderrText: string;
  readonly bufferTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
}

export type RunRgOutcome = RunRgResult | { readonly kind: 'aborted' };

function disposeProcess(proc: IHostProcess): void {
  try {
    proc.dispose();
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Spawn `rgArgs` (`[rgPath, ...args]`) through the host `IHostProcessService`
 * and drain its stdout/stderr with a byte cap. Handles abort (via `signal`)
 * and a hard timeout with a two-phase kill (SIGTERM, then SIGKILL after a
 * grace period) and process disposal. Returns `{ kind: 'aborted' }` when the
 * run is cancelled so the caller can surface a stable "aborted" message. Spawn
 * failures (e.g. ENOENT) are thrown to the caller.
 */
export async function runRgOnce(
  processService: IHostProcessService,
  rgArgs: readonly string[],
  signal: AbortSignal,
  options?: { readonly cwd?: string },
): Promise<RunRgOutcome> {
  if (signal.aborted) {
    return { kind: 'aborted' };
  }

  const [command, ...args] = rgArgs;
  if (command === undefined) {
    throw new Error('runRgOnce: rgArgs must not be empty');
  }
  const proc: IHostProcess = await processService.spawn(command, args, { cwd: options?.cwd });

  try {
    proc.stdin.end();
  } catch {
    /* already gone */
  }

  let timedOut = false;
  let aborted = false;
  let killed = false;

  const killProc = async (): Promise<void> => {
    if (killed) return;
    killed = true;
    try {
      await proc.kill('SIGTERM');
    } catch {
      /* process already gone */
    }
    const exited = proc
      .wait()
      .then(() => true)
      .catch(() => true);
    const raced = await Promise.race([
      exited,
      new Promise<false>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, SIGTERM_GRACE_MS);
      }),
    ]);
    if (!raced && proc.exitCode === null) {
      try {
        await proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    disposeProcess(proc);
  };

  const onAbort = (): void => {
    aborted = true;
    void killProc();
  };
  signal.addEventListener('abort', onAbort);
  // AbortSignal does not replay past abort events; check once after registering
  // the listener so already-aborted calls still run the cleanup path.
  if (signal.aborted) onAbort();

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    void killProc();
  }, DEFAULT_TIMEOUT_MS);

  let exitCode = 0;
  let stdoutText = '';
  let stderrText = '';
  let bufferTruncated = false;
  let stderrTruncated = false;

  try {
    const isTerminating = (): boolean => timedOut || aborted || killed;
    const [stdoutResult, stderrResult, code] = await Promise.all([
      readStreamWithCap(proc.stdout, MAX_OUTPUT_BYTES, isTerminating),
      readStreamWithCap(proc.stderr, MAX_OUTPUT_BYTES, isTerminating),
      proc.wait(),
    ]);
    stdoutText = stdoutResult.text;
    stderrText = stderrResult.text;
    bufferTruncated = stdoutResult.truncated;
    stderrTruncated = stderrResult.truncated;
    exitCode = code;
  } catch (error) {
    if (!(isPrematureCloseError(error) && (timedOut || aborted || killed))) {
      throw error;
    }
    // The disposer intentionally closes streams after a terminating signal.
  } finally {
    clearTimeout(timeoutHandle);
    signal.removeEventListener('abort', onAbort);
    disposeProcess(proc);
  }

  if (aborted) {
    return { kind: 'aborted' };
  }

  return {
    kind: 'result',
    exitCode,
    stdoutText,
    stderrText,
    bufferTruncated,
    stderrTruncated,
    timedOut,
  };
}

/**
 * ripgrep can fail with `os error 11` (EAGAIN, "Resource temporarily
 * unavailable") when its thread pool can't spawn a worker under load. A single
 * single-threaded retry (`-j 1`) sidesteps the pool and usually succeeds.
 */
export function shouldRetryRipgrepEagain(result: RunRgResult): boolean {
  return (
    result.exitCode !== 0 &&
    result.exitCode !== 1 &&
    !result.timedOut &&
    isEagainRipgrepError(result.stderrText)
  );
}

function isEagainRipgrepError(stderr: string): boolean {
  return stderr.includes('os error 11') || stderr.includes('Resource temporarily unavailable');
}

function isPrematureCloseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}

interface CappedStreamResult {
  readonly text: string;
  readonly truncated: boolean;
}

async function readStreamWithCap(
  stream: Readable,
  maxBytes: number,
  suppressPrematureClose?: () => boolean,
): Promise<CappedStreamResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buf: Buffer =
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
      if (truncated) continue;
      if (total + buf.length > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        continue;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } catch (error) {
    if (!isPrematureCloseError(error) || suppressPrematureClose?.() !== true) {
      throw error;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

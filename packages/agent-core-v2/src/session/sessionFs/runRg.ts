/**
 * `sessionFs` domain — shared ripgrep subprocess plumbing.
 *
 * Single place that knows how Glob spawns `rg` through the session
 * `ISessionProcessRunner`: timeout / abort handling, capped stdout / stderr
 * draining, two-phase kill with process disposal, and the EAGAIN retry
 * predicate. Mode-specific argument building and output parsing stay in the
 * tools themselves.
 *
 * Ported from v1 (`packages/agent-core/src/tools/support/run-rg.ts`) onto the
 * v2 `ISessionProcessRunner`. Grep keeps its own `runCommand` path in
 * `fsService` (it streams JSON and has a pure-node fallback); this helper is
 * shared in the sense that the previously inline Glob plumbing now lives in one
 * reusable module under the same `sessionFs` domain as Grep's search code.
 */

import type { Readable } from 'node:stream';

import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const SIGTERM_GRACE_MS = 5_000;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface RunRgResult {
  readonly kind: 'result';
  readonly exitCode: number;
  readonly stdoutText: string;
  readonly stderrText: string;
  readonly bufferTruncated: boolean;
  readonly timedOut: boolean;
}

export type RunRgOutcome = RunRgResult | { readonly kind: 'aborted' };

async function disposeProcess(proc: IProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
  }
}

export async function runRgOnce(
  runner: ISessionProcessRunner,
  rgArgs: readonly string[],
  signal: AbortSignal,
  options?: { readonly cwd?: string },
): Promise<RunRgOutcome> {
  if (signal.aborted) {
    return { kind: 'aborted' };
  }

  const proc: IProcess = await runner.exec(rgArgs, { cwd: options?.cwd });

  try {
    proc.stdin.end();
  } catch {
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
      }
    }
    await disposeProcess(proc);
  };

  const onAbort = (): void => {
    aborted = true;
    void killProc();
  };
  signal.addEventListener('abort', onAbort);
  if (signal.aborted) onAbort();

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    void killProc();
  }, DEFAULT_TIMEOUT_MS);

  let exitCode = 0;
  let stdoutText = '';
  let stderrText = '';
  let bufferTruncated = false;

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
    exitCode = code;
  } catch (error) {
    if (!(isPrematureCloseError(error) && (timedOut || aborted || killed))) {
      throw error;
    }
  } finally {
    clearTimeout(timeoutHandle);
    signal.removeEventListener('abort', onAbort);
    await disposeProcess(proc);
  }

  if (aborted) {
    return { kind: 'aborted' };
  }

  return { kind: 'result', exitCode, stdoutText, stderrText, bufferTruncated, timedOut };
}

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

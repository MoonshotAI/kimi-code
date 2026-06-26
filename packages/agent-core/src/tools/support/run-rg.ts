/**
 * run-rg — shared ripgrep subprocess plumbing.
 *
 * Single place that knows how we spawn `rg` through Kaos: timeout / abort
 * handling, capped stdout / stderr draining, two-phase kill with process
 * disposal, and the standard exclusion globs (VCS metadata + sensitive
 * files) shared by GrepTool and GlobTool. Mode-specific argument building
 * and output parsing stay in the tools themselves.
 */

import type { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';

import type { ExecutableToolResult } from '../../loop/types';
import { SENSITIVE_DOT_VARIANT_SUFFIXES } from '../policies/sensitive';

import { rgUnavailableMessage } from './rg-locator';
import { isPrematureCloseError } from './stream';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const SIGTERM_GRACE_MS = 5_000;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const;

// Conservative prefilter. The authoritative sensitive-file check still happens
// on parsed rg records after execution.
export const SENSITIVE_KEY_BASENAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa'] as const;
export const SENSITIVE_KEY_GLOBS_TO_EXCLUDE = SENSITIVE_KEY_BASENAMES.flatMap((name) => [
  `**/${name}`,
  `**/${name}[-_]*`,
  ...SENSITIVE_DOT_VARIANT_SUFFIXES.map((suffix) => `**/${name}${suffix}`),
]);
export const SENSITIVE_GLOBS_TO_EXCLUDE = [
  '**/.env',
  ...SENSITIVE_KEY_GLOBS_TO_EXCLUDE,
  '**/.aws/credentials',
  '**/.aws/credentials/**',
  '**/.gcp/credentials',
  '**/.gcp/credentials/**',
] as const;

export interface RipgrepRunResult {
  readonly kind: 'result';
  readonly exitCode: number;
  readonly stdoutText: string;
  readonly stderrText: string;
  readonly bufferTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
}

export type RipgrepRunOutcome =
  | RipgrepRunResult
  | { readonly kind: 'tool-error'; readonly result: ExecutableToolResult };

export interface RunRipgrepOptions {
  /** Message surfaced when the run is aborted via `signal`. Defaults to `"Aborted"`. */
  readonly abortedMessage?: string;
}

async function disposeProcess(proc: KaosProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
    /* best-effort cleanup */
  }
}

export async function runRipgrepOnce(
  kaos: Kaos,
  rgArgs: readonly string[],
  signal: AbortSignal,
  options: RunRipgrepOptions = {},
): Promise<RipgrepRunOutcome> {
  const abortedMessage = options.abortedMessage ?? 'Aborted';
  if (signal.aborted) {
    return { kind: 'tool-error', result: { isError: true, output: abortedMessage } };
  }

  let proc: KaosProcess;
  try {
    proc = await kaos.exec(...rgArgs);
  } catch (error) {
    // Spawn can still fail after path resolution, e.g. permissions or a
    // corrupt binary. ENOENT gets the same actionable hint as locator failures.
    const isEnoent =
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      kind: 'tool-error',
      result: {
        isError: true,
        output: isEnoent
          ? rgUnavailableMessage(error)
          : error instanceof Error
            ? error.message
            : String(error),
      },
    };
  }

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
    await disposeProcess(proc);
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
    if (isPrematureCloseError(error) && (timedOut || aborted || killed)) {
      // The disposer intentionally closes streams after a terminating signal.
    } else {
      return {
        kind: 'tool-error',
        result: {
          isError: true,
          output: error instanceof Error ? error.message : String(error),
        },
      };
    }
  } finally {
    clearTimeout(timeoutHandle);
    signal.removeEventListener('abort', onAbort);
    await disposeProcess(proc);
  }

  if (aborted) {
    return { kind: 'tool-error', result: { isError: true, output: abortedMessage } };
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

export function shouldRetryRipgrepEagain(result: RipgrepRunResult): boolean {
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

import { type SpawnOptionsWithoutStdio } from 'node:child_process';

import { z } from 'zod';

import { sliceOnCodePointBoundary } from '#/_base/text/code-points';
import { type IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

import type { HookResult } from './types';

export const HOOK_STREAM_MAX_CHARS = 1_000_000;
export const HOOK_CONTEXT_MAX_CHARS = 8_000;
export const HOOK_BLOCK_REASON_MAX_CHARS = 2_000;

export function truncateHookText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${sliceOnCodePointBoundary(text, maxChars)}… [truncated]`;
}

export interface RunHookOptions {
  readonly timeout: number;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export function buildHookSpawnOptions(options: {
  cwd?: string;
  env?: Record<string, string>;
}): SpawnOptionsWithoutStdio {
  return {
    shell: true,
    cwd: options.cwd,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: options.env === undefined ? undefined : { ...process.env, ...options.env },
  };
}

const DEFAULT_TIMEOUT_SECONDS = 30;
const KILL_GRACE_MS = 100;
const OptionalStringSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    return undefined;
  },
  z.string().optional(),
);
const HookSpecificOutputSchema = z.preprocess(
  (value) => (isRecord(value) ? value : undefined),
  z
    .looseObject({
      message: OptionalStringSchema,
      permissionDecision: z.unknown().optional(),
      permissionDecisionReason: z.unknown().optional(),
    })
    .optional(),
);
const HookJsonOutputSchema = z.looseObject({
  message: OptionalStringSchema,
  hookSpecificOutput: HookSpecificOutputSchema,
});

export async function runHook(
  hostProcess: IHostProcessService,
  command: string,
  input: Record<string, unknown>,
  options: RunHookOptions,
): Promise<HookResult> {
  let proc: IHostProcess;
  try {
    proc = await hostProcess.spawn(command, [], {
      shell: true,
      cwd: options.cwd,
      env: options.env,
    });
  } catch (error) {
    return allowResult({ stderr: errorMessage(error), errored: true, error: errorMessage(error) });
  }

  return new Promise<HookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const timeoutMs = timeoutSeconds(options.timeout) * 1000;

    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const settle = (result: HookResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      if (stdoutTruncated) return;
      if (stdout.length + chunk.length > HOOK_STREAM_MAX_CHARS) {
        stdout = truncateHookText(stdout + chunk, HOOK_STREAM_MAX_CHARS);
        stdoutTruncated = true;
        return;
      }
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk: string) => {
      if (stderrTruncated) return;
      if (stderr.length + chunk.length > HOOK_STREAM_MAX_CHARS) {
        stderr = truncateHookText(stderr + chunk, HOOK_STREAM_MAX_CHARS);
        stderrTruncated = true;
        return;
      }
      stderr += chunk;
    });

    const stdoutDone = new Promise<void>((done) => proc.stdout.once('end', done));
    const stderrDone = new Promise<void>((done) => proc.stderr.once('end', done));
    void Promise.all([proc.wait(), stdoutDone, stderrDone]).then(
      ([code]) => {
        void proc.dispose();
        settle(resultFromExitCode(code, stdout, stderr, stdoutTruncated));
      },
      (error) => {
        void proc.dispose();
        settle(allowResult({ stdout, stderr: stderr + errorMessage(error), errored: true, error: errorMessage(error) }));
      },
    );

    const timeout = setTimeout(() => {
      killProcess(proc);
      settle(allowResult({ stdout, stderr, timedOut: true }));
    }, timeoutMs);

    const onAbort = (): void => {
      killProcess(proc);
      settle(allowResult({ stdout, stderr }));
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }

    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify(input));
  });
}

function timeoutSeconds(timeout: number): number {
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS;
}

function resultFromExitCode(
  exitCode: number,
  stdout: string,
  stderr: string,
  stdoutTruncated: boolean,
): HookResult {
  if (exitCode === 2) {
    const message = truncateHookText(stderr.trim(), HOOK_BLOCK_REASON_MAX_CHARS);
    return {
      action: 'block',
      message,
      reason: message,
      stdout,
      stderr,
      exitCode,
    };
  }

  const structured = exitCode === 0 && !stdoutTruncated ? structuredOutput(stdout) : undefined;
  if (structured?.action === 'block') {
    const message = structured.message ?? structured.reason;
    return {
      action: 'block',
      message: message === undefined ? undefined : truncateHookText(message, HOOK_BLOCK_REASON_MAX_CHARS),
      reason: structured.reason === undefined
        ? undefined
        : truncateHookText(structured.reason, HOOK_BLOCK_REASON_MAX_CHARS),
      stdout,
      stderr,
      exitCode,
      structuredOutput: structured.structuredOutput,
    };
  }

  return allowResult({
    message: structured?.message === undefined
      ? undefined
      : truncateHookText(structured.message, HOOK_CONTEXT_MAX_CHARS),
    stdout,
    stderr,
    exitCode,
    structuredOutput: structured?.structuredOutput,
  });
}

function structuredOutput(
  stdout: string,
): { action?: 'block'; reason?: string; message?: string; structuredOutput: true } | undefined {
  const text = stdout.trim();
  if (text.length === 0) return undefined;

  try {
    const parsed = JSON.parse(text) as unknown;
    const output = HookJsonOutputSchema.safeParse(parsed);
    if (!output.success) return undefined;

    const { message, hookSpecificOutput } = output.data;
    const result = {
      message: message ?? hookSpecificOutput?.message,
      structuredOutput: true as const,
    };
    if (hookSpecificOutput?.permissionDecision !== 'deny') {
      return result;
    }
    return {
      action: 'block',
      message: result.message,
      reason:
        typeof hookSpecificOutput.permissionDecisionReason === 'string'
          ? hookSpecificOutput.permissionDecisionReason
          : undefined,
      structuredOutput: true as const,
    };
  } catch {
    return undefined;
  }
}

function allowResult(input: {
  readonly message?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly errored?: boolean;
  readonly structuredOutput?: boolean;
  readonly error?: string;
}): HookResult {
  return {
    action: 'allow',
    message: input.message,
    stdout: input.stdout,
    stderr: input.stderr,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    errored: input.errored,
    structuredOutput: input.structuredOutput,
    error: input.error,
  };
}

function killProcess(proc: IHostProcess): void {
  void proc.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    void proc.kill('SIGKILL');
  }, KILL_GRACE_MS);
  killTimer.unref();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

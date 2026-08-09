import { type SpawnOptionsWithoutStdio } from 'node:child_process';

import { z } from 'zod';

import { type IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

import type { HookResult } from './types';

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
    return allowResult({ stderr: errorMessage(error) });
  }

  return new Promise<HookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
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
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const stdoutDone = new Promise<void>((done) => proc.stdout.once('end', done));
    const stderrDone = new Promise<void>((done) => proc.stderr.once('end', done));
    void Promise.all([proc.wait(), stdoutDone, stderrDone]).then(
      ([code]) => {
        proc.dispose();
        settle(resultFromExitCode(code, stdout, stderr));
      },
      (error) => {
        proc.dispose();
        settle(allowResult({ stdout, stderr: stderr + errorMessage(error) }));
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

function resultFromExitCode(exitCode: number, stdout: string, stderr: string): HookResult {
  if (exitCode === 2) {
    const message = stderr.trim();
    return {
      action: 'block',
      message,
      reason: message,
      stdout,
      stderr,
      exitCode,
    };
  }

  const structured = exitCode === 0 ? structuredOutput(stdout) : undefined;
  if (structured?.action === 'block') {
    return {
      action: 'block',
      message: structured.message ?? structured.reason,
      reason: structured.reason,
      stdout,
      stderr,
      exitCode,
      structuredOutput: structured.structuredOutput,
    };
  }

  return allowResult({
    message: structured?.message,
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
  readonly structuredOutput?: boolean;
}): HookResult {
  return {
    action: 'allow',
    message: input.message,
    stdout: input.stdout,
    stderr: input.stderr,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    structuredOutput: input.structuredOutput,
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

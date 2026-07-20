import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';

import { z } from 'zod';

import type { HookResult } from './types';
import { isRecord } from '../../utils/guards';

export interface RunHookOptions {
  readonly timeout: number;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export function buildHookSpawnOptions(options: {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}): SpawnOptionsWithoutStdio {
  return {
    shell: false,
    cwd: options.cwd,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: options.env ? { ...process.env, ...options.env } : undefined,
  };
}

/**
 * Parse a hook command string into binary + args, respecting
 * single- and double-quoted tokens (handles paths with spaces).
 * Falls back to explicit shell invocation only when the command
 * contains dangerous shell metacharacters (command chaining,
 * substitution) that cannot be represented as argv.
 */
function parseHookCommand(command: string): { binary: string; args: string[] } {
  const trimmed = command.trim();
  const parts = splitShellArgs(trimmed);
  if (
    parts.length > 0 &&
    !hasDangerousMetachars(trimmed) &&
    !SHELL_BUILTINS.has(parts[0]!)
  ) {
    return { binary: parts[0]!, args: parts.slice(1) };
  }
  // Fall back to explicit shell invocation.
  if (process.platform === 'win32') {
    return { binary: 'cmd.exe', args: ['/d', '/s', '/c', trimmed] };
  }
  return { binary: '/bin/sh', args: ['-c', trimmed] };
}

/** Shell metacharacters that indicate command chaining or substitution. */
const DANGEROUS_METACHARS = /[;&|`$(){}<>]/;

/**
 * POSIX shell builtins are not standalone executables, so spawning them
 * directly fails (ENOENT); they must be run through a shell.
 */
const SHELL_BUILTINS = new Set([
  '.', ':', 'alias', 'bg', 'break', 'cd', 'command', 'continue', 'declare',
  'echo', 'eval', 'exec', 'exit', 'export', 'false', 'fg', 'getopts', 'hash',
  'jobs', 'kill', 'let', 'local', 'printf', 'pwd', 'read', 'readonly',
  'return', 'set', 'shift', 'source', 'test', 'times', 'trap', 'true',
  'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
]);

function hasDangerousMetachars(command: string): boolean {
  return DANGEROUS_METACHARS.test(command);
}

/** Split a command string into argv respecting single/double quotes.
 *  Returns an empty array on unterminated quotes (caller falls back to shell). */
function splitShellArgs(command: string): string[] {
  const result: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (inSingle) {
      if (ch === "'") { inSingle = false; }
      else { current += ch; }
    } else if (inDouble) {
      if (ch === '"') { inDouble = false; }
      else if (ch === '\\' && i + 1 < command.length && command[i + 1] === '"') {
        i++;
        current += '"';
      } else {
        current += ch;
      }
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) { result.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (inSingle || inDouble) return [];
  if (current.length > 0) result.push(current);
  return result;
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
      permissionDecisionReason: OptionalStringSchema,
    })
    .optional(),
);
const HookJsonOutputSchema = z.looseObject({
  message: OptionalStringSchema,
  hookSpecificOutput: HookSpecificOutputSchema,
});

export async function runHook(
  command: string,
  input: Record<string, unknown>,
  options: RunHookOptions,
): Promise<HookResult> {
  let child: ChildProcessWithoutNullStreams;
  try {
    const parsed = parseHookCommand(command);
    child = spawn(parsed.binary, parsed.args, buildHookSpawnOptions({ cwd: options.cwd, env: options.env }));
  } catch (error) {
    return allowResult({ stderr: errorMessage(error) });
  }

  return new Promise<HookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = timeoutSeconds(options.timeout) * 1000;

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const settle = (result: HookResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      killProcess(child);
      settle(allowResult({ stdout, stderr, timedOut: true }));
    }, timeoutMs);

    const onAbort = (): void => {
      killProcess(child);
      settle(allowResult({ stdout, stderr }));
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      settle(allowResult({ stdout, stderr: stderr + errorMessage(error) }));
    });
    child.on('close', (code) => {
      settle(resultFromExitCode(code ?? 0, stdout, stderr));
    });

    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
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
      reason: hookSpecificOutput.permissionDecisionReason,
      structuredOutput: true,
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

function killProcess(child: ChildProcessWithoutNullStreams): void {
  tryKillProcess(child, 'SIGTERM');
  const killTimer = setTimeout(() => {
    tryKillProcess(child, 'SIGKILL');
  }, KILL_GRACE_MS);
  killTimer.unref();
}

function tryKillProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    // On Windows, `ChildProcess.kill()` only signals the shell spawned by
    // `shell: true`, leaving grandchildren (the actual hook command) alive
    // and holding the cwd. `taskkill /T` terminates the whole process tree.
    killProcessTreeWindows(child, signal === 'SIGKILL');
    return;
  }
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Final fallback — process is already defunct, nothing more to do.
    }
  }
}

function killProcessTreeWindows(child: ChildProcessWithoutNullStreams, force: boolean): void {
  if (child.pid === undefined) return;
  const args = force
    ? ['/T', '/F', '/PID', String(child.pid)]
    : ['/T', '/PID', String(child.pid)];
  try {
    const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => {});
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // Process already exited — nothing left to clean up.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

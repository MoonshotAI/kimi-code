import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { homedir } from 'node:os';

import { z } from 'zod';

import type { HookResult } from './types';

/**
 * Expand a word-leading `~` to the home directory.
 *
 * Hook commands are spawned with `shell: true`. On POSIX that shell performs
 * tilde expansion, so `python3 ~/hooks/x.py` finds the script. On Windows the
 * shell is cmd.exe, which has no such concept: the literal `~` reaches the
 * interpreter, which resolves it against the WORKING DIRECTORY. A hook
 * configured with a `~` path therefore fails with ENOENT at
 * `<cwd>/~/hooks/x.py` — and because a failed PreToolUse hook blocks the call,
 * that silently breaks EVERY tool use in the session rather than just the hook.
 *
 * Expansion is applied at word boundaries only, which is where a POSIX shell
 * does it, so a `~` inside an argument keeps its literal meaning.
 *
 * The expanded home is spliced into a command string the shell re-parses, so
 * when it contains whitespace or shell metacharacters (e.g. `C:\Users\Jane
 * Doe`) it is wrapped in double quotes to keep it a single word — a POSIX
 * shell's own tilde expansion never word-splits, and this textual replacement
 * must not reintroduce that hazard. Double quotes keep the path one word in
 * both cmd.exe and POSIX sh, including the concatenated form
 * `"<home>"/hooks/x.py`.
 */
export function expandLeadingTilde(command: string, home: string = homedir()): string {
  const replacement = quoteHomeForShell(home);
  return command.replaceAll(/(^|\s)~(?=[/\\]|\s|$)/g, (_match, prefix: string) => `${prefix}${replacement}`);
}

// Characters that a shell treats as ordinary word content: alphanumerics,
// `_`, and the path punctuation `- . / : \`. Anything else (whitespace,
// `& | ; < > ( ) % ^ " '`, …) would split or reinterpret the substituted
// path, so such a home is double-quoted.
const SHELL_SAFE_HOME = /^[\w./:\\-]+$/;

function quoteHomeForShell(home: string): string {
  return SHELL_SAFE_HOME.test(home) ? home : `"${home}"`;
}

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
    shell: true,
    cwd: options.cwd,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    // Hide the console Windows would otherwise allocate for the shell child.
    // Without `windowsHide:true`, each hook flashes a visible console window —
    // the same regression the Bash tool path already guards against in KAOS
    // (see `buildLocalSpawnOptions`). Unconditional: it is a no-op on POSIX.
    windowsHide: true,
    env: options.env ? { ...process.env, ...options.env } : undefined,
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
    child = spawn(
      expandLeadingTilde(command),
      buildHookSpawnOptions({ cwd: options.cwd, env: options.env }),
    );
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
    } catch {}
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
    } catch {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

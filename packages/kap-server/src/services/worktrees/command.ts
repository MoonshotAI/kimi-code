import type { Readable } from 'node:stream';

import { HostProcessService, type IHostProcess } from '@moonshot-ai/agent-core-v2';
import { resolveProgramPath } from '@moonshot-ai/agent-core-v2/environment/programPath';

export const COMMAND_OUTPUT_TAIL_CHARS = 16_384;
const COMMAND_STDOUT_MAX_CHARS = 16 * 1024 * 1024;

const processes = new HostProcessService();

export interface CommandOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onOutput?: (tail: string) => void;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly output: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError?: NodeJS.ErrnoException;
}

export function tailOf(text: string, limit = COMMAND_OUTPUT_TAIL_CHARS): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function spawnFailure(error: unknown): CommandResult {
  const failure = error instanceof Error ? error : new Error(String(error));
  return {
    exitCode: null,
    stdout: '',
    output: `${failure.message}\n`,
    timedOut: false,
    aborted: false,
    spawnError: failure.cause instanceof Error ? failure.cause : failure,
  };
}

function drain(stream: Readable, onChunk: (chunk: string) => void): Promise<void> {
  return new Promise((resolve) => {
    stream.setEncoding('utf-8');
    stream.on('data', onChunk);
    stream.on('error', () => {});
    stream.once('close', resolve);
  });
}

export async function runCommand(
  program: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const isAborted = (): boolean => options.signal?.aborted === true;
  if (isAborted()) {
    return { exitCode: null, stdout: '', output: '', timedOut: false, aborted: true };
  }
  let proc: IHostProcess;
  try {
    proc = await processes.spawn(program, args, {
      cwd: options.cwd,
      env: options.env === undefined ? undefined : { ...options.env },
    });
  } catch (error) {
    return spawnFailure(error);
  }
  let stdout = '';
  let output = '';
  let timedOut = false;
  let aborted = false;
  const append = (chunk: string, fromStdout: boolean): void => {
    if (fromStdout && stdout.length < COMMAND_STDOUT_MAX_CHARS) stdout += chunk;
    output = tailOf(output + chunk);
    options.onOutput?.(output);
  };
  const kill = (): void => {
    void proc.kill('SIGKILL').catch(() => {});
  };
  const onAbort = (): void => {
    aborted = true;
    kill();
  };
  proc.stdin.on('error', () => {});
  proc.stdin.end();
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs);
  if (isAborted()) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const [code] = await Promise.all([
      proc.wait().catch(() => -1),
      drain(proc.stdout, (chunk) => {
        append(chunk, true);
      }),
      drain(proc.stderr, (chunk) => {
        append(chunk, false);
      }),
    ]);
    return {
      exitCode: timedOut || aborted || code < 0 ? null : code,
      stdout,
      output,
      timedOut,
      aborted,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    void proc.dispose();
  }
}

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
  LANG: 'C',
};

const GIT_READ_TIMEOUT_MS = 30_000;

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: Omit<CommandOptions, 'cwd'> = {},
): Promise<CommandResult> {
  let program: string;
  try {
    program = resolveProgramPath('git', { cwd });
  } catch (error) {
    return spawnFailure(error);
  }
  return runCommand(program, args, {
    ...options,
    cwd,
    env: { ...GIT_ENV, ...options.env },
    timeoutMs: options.timeoutMs ?? GIT_READ_TIMEOUT_MS,
  });
}

export async function gitText(cwd: string, args: readonly string[]): Promise<string | undefined> {
  const result = await runGit(cwd, args);
  return result.exitCode === 0 ? result.stdout.replace(/\r?\n$/, '') : undefined;
}

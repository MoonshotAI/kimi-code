import { spawn } from 'node:child_process';

export const COMMAND_OUTPUT_TAIL_CHARS = 16_384;
const COMMAND_STDOUT_MAX_CHARS = 16 * 1024 * 1024;

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

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
}

export async function runCommand(
  program: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  if (options.signal?.aborted === true) {
    return { exitCode: null, stdout: '', output: '', timedOut: false, aborted: true };
  }
  const child = spawn(program, [...args], {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let stdout = '';
  let output = '';
  let timedOut = false;
  let aborted = false;
  let spawnError: NodeJS.ErrnoException | undefined;
  const append = (chunk: string, fromStdout: boolean): void => {
    if (fromStdout && stdout.length < COMMAND_STDOUT_MAX_CHARS) stdout += chunk;
    output = tailOf(output + chunk);
    options.onOutput?.(output);
  };
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    append(chunk, true);
  });
  child.stderr.on('data', (chunk: string) => {
    append(chunk, false);
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    spawnError = error;
  });
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, options.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    killTree(child.pid);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const code = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });
  if (timer !== undefined) clearTimeout(timer);
  options.signal?.removeEventListener('abort', onAbort);
  return {
    exitCode: spawnError === undefined && !timedOut && !aborted ? code : null,
    stdout,
    output: spawnError === undefined ? output : tailOf(`${output}${spawnError.message}\n`),
    timedOut,
    aborted,
    spawnError,
  };
}

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
  LANG: 'C',
};

const GIT_READ_TIMEOUT_MS = 30_000;

export function runGit(
  cwd: string,
  args: readonly string[],
  options: Omit<CommandOptions, 'cwd'> = {},
): Promise<CommandResult> {
  return runCommand('git', args, {
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

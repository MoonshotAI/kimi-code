/**
 * `sessionFs` domain (L2) — `runCommand` helper over `ISessionProcessRunner`.
 *
 * Collects a child process's full stdout/stderr and exit code through the
 * Agent's backend-pluggable `ISessionProcessRunner`, with optional `AbortSignal`
 * support (the caller decides timeout semantics — git has none, `gh pr view`
 * uses 5s, `rg` grep uses 30s). Kept separate from `fsService` so it can be
 * unit-tested with a fake runner.
 */

import { type Readable } from 'node:stream';

import { type IProcess, type ISessionProcessRunner } from '#/session/process/processRunner';

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCommandOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export async function runCommand(
  runner: ISessionProcessRunner,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunResult> {
  const proc: IProcess = await runner.exec(args, {
    cwd: options.cwd,
    env: options.env,
  });

  const signal = options.signal;
  const onAbort = (): void => {
    void proc.kill('SIGKILL');
  };
  if (signal !== undefined) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.wait().catch(() => -1),
  ]);
  return { exitCode, stdout, stderr };
}

export function readStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      data += chunk;
    });
    stream.once('end', () => resolve(data));
    stream.once('error', reject);
  });
}

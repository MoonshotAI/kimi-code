/**
 * `workspaceFs` domain — `runCommand` helper over `ISessionProcessRunner`.
 *
 * Collects a child process's full stdout/stderr and exit code through the
 * Agent's backend-pluggable `ISessionProcessRunner`, with optional `AbortSignal`
 * support (the caller decides timeout semantics). Kept as a standalone
 * helper so it can be unit-tested with a fake runner.
 */

import { type Readable } from 'node:stream';

import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

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
  runner: IHostProcessService,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunResult> {
  const command = args[0];
  if (command === undefined) throw new Error('runCommand requires a command');
  const proc: IHostProcess = await runner.spawn(command, args.slice(1), {
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

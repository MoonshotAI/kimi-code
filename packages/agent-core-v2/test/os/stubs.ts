import { Readable, type Writable } from 'node:stream';

import { vi } from 'vitest';

import type { IHostProcess } from '#/os/interface/hostProcess';

export function stubHostProcess(stdout: string, exitCode: number, stderr = ''): IHostProcess {
  const stdoutStream = Readable.from([Buffer.from(stdout)]);
  const stderrStream = Readable.from([Buffer.from(stderr)]);
  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: stdoutStream,
    stderr: stderrStream,
    pid: 1,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      stdoutStream.destroy();
      stderrStream.destroy();
    }),
  };
}

export function stubRgProbe(resolveExitCode: (args: readonly string[]) => number): {
  readonly exec: ReturnType<
    typeof vi.fn<(args: readonly string[]) => Promise<{ readonly exitCode: number }>>
  >;
} {
  return {
    exec: vi.fn(async (args: readonly string[]) => ({ exitCode: resolveExitCode(args) })),
  };
}

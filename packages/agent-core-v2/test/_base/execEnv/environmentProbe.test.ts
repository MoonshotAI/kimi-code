/**
 * Host environment probe — MSYS2 bash detection.
 *
 * Pins the Windows shell probe against native MSYS2 toolchains: a git whose
 * `git --exec-path` reports an `ucrt64` / `clang64` / `clangarm64` prefix
 * (e.g. `C:/msys64/ucrt64/libexec/git-core`) must walk back to the MSYS2 root
 * and resolve the shared bash at `usr\bin\bash.exe`, instead of failing to
 * detect any shell.
 *
 * All tests expect `probeHostEnvironment()` to be a pure function of injected
 * platform probes (no ambient state) so the same suite runs identically on
 * macOS/Linux/Windows CI runners.
 *
 * Ported from `packages/kaos/test/environment.test.ts` (the MSYS2 cases added
 * by the bash-detection fix); the v1 file carries the full POSIX / Git for
 * Windows / Scoop shim matrix, which the vendored probe shares verbatim.
 */

import { describe, expect, it } from 'vitest';

import {
  probeHostEnvironment,
  type HostEnvironmentProbeDeps,
} from '#/_base/execEnv/environmentProbe';

interface StubOpts {
  readonly platform: string;
  readonly env?: Record<string, string | undefined>;
  readonly existingPaths?: readonly string[];
  readonly execFileResults?: Readonly<Record<string, string>>;
}

function stubDeps(opts: StubOpts): HostEnvironmentProbeDeps {
  const existing = new Set(opts.existingPaths ?? []);
  return {
    platform: opts.platform,
    arch: 'x86_64',
    release: '1.2.3',
    homeDir: 'C:\\Users\\me',
    env: opts.env ?? {},
    isFile: async (path: string) => existing.has(path),
    execFileText: async (file: string, args: readonly string[]) =>
      opts.execFileResults?.[execFileKey(file, args)],
  };
}

function execFileKey(file: string, args: readonly string[]): string {
  return [file, ...args].join('\0');
}

describe('probeHostEnvironment', () => {
  it('resolves MSYS2 ucrt64 native git through git --exec-path', async () => {
    const gitExe = 'C:\\msys64\\ucrt64\\bin\\git.exe';
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\msys64\\ucrt64\\bin' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]: 'C:/msys64/ucrt64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\msys64\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\msys64\\usr\\bin\\bash.exe');
  });

  it('resolves MSYS2 clang64 native git through git --exec-path', async () => {
    const gitExe = 'C:\\msys64\\clang64\\bin\\git.exe';
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\msys64\\clang64\\bin' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]: 'C:/msys64/clang64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\msys64\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\msys64\\usr\\bin\\bash.exe');
  });

  it('resolves MSYS2 clangarm64 native git through git --exec-path', async () => {
    const gitExe = 'C:\\msys64\\clangarm64\\bin\\git.exe';
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\msys64\\clangarm64\\bin' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]: 'C:/msys64/clangarm64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\msys64\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\msys64\\usr\\bin\\bash.exe');
  });
});

/**
 * Environment detection.
 *
 * Pins the cross-platform shape of `detectEnvironment()`:
 *
 *   - macOS / Linux / Windows / unknown → `osKind`
 *   - POSIX path probing prefers /bin/bash, falls back to /usr/bin/bash,
 *     /usr/local/bin/bash, then /bin/sh (with shellName 'sh').
 *   - Windows resolves Git Bash via `KIMI_SHELL_PATH`, `git.exe` on PATH
 *     (including `git --exec-path` for shims), or well-known install
 *     locations; throws `KaosShellNotFoundError`
 *     if none are present.
 *   - `osArch` / `osVersion` are populated from the Node OS APIs.
 *
 * All tests expect `detectEnvironment()` to be a pure function of
 * injected platform probes (no ambient state) so the same suite runs
 * identically on macOS/Linux/Windows CI runners.
 */

import { describe, expect, it } from 'vitest';

import {
  detectEnvironment,
  type Environment,
  type OsKind,
  type ShellName,
} from '#/environment';
import { KaosShellNotFoundError } from '#/errors';

interface StubOpts {
  readonly platform: NodeJS.Platform;
  readonly arch?: string;
  readonly release?: string;
  readonly env?: Record<string, string | undefined>;
  readonly existingPaths?: readonly string[];
  readonly execFileResults?: Readonly<Record<string, string>>;
  readonly execFileText?: Parameters<typeof detectEnvironment>[0]['execFileText'];
}

/** Build a stub deps bag mimicking Node's `os` + `process` surface. */
function stubDeps(opts: StubOpts): Parameters<typeof detectEnvironment>[0] {
  const existing = new Set(opts.existingPaths ?? []);
  return {
    platform: opts.platform,
    arch: opts.arch ?? 'x86_64',
    release: opts.release ?? '1.2.3',
    env: opts.env ?? {},
    isFile: async (path: string) => existing.has(path),
    execFileText:
      opts.execFileText ??
      (async (file: string, args: readonly string[]) => opts.execFileResults?.[execFileKey(file, args)]),
  };
}

function execFileKey(file: string, args: readonly string[]): string {
  return [file, ...args].join('\0');
}

describe('detectEnvironment', () => {
  it('reports osKind "macOS" on darwin', async () => {
    const env: Environment = await detectEnvironment(
      stubDeps({
        platform: 'darwin',
        arch: 'arm64',
        release: '23.4.0',
        existingPaths: ['/bin/bash'],
      }),
    );
    expect(env.osKind satisfies OsKind).toBe('macOS');
    expect(env.osArch).toBe('arm64');
    expect(env.osVersion).toBe('23.4.0');
  });

  it('reports osKind "Linux" on linux', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'linux', existingPaths: ['/bin/bash'] }),
    );
    expect(env.osKind).toBe('Linux');
  });

  it('reports osKind "Windows" on win32', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        existingPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.osKind).toBe('Windows');
  });

  it('passes through unknown platform string verbatim', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'freebsd' as NodeJS.Platform, existingPaths: ['/bin/sh'] }),
    );
    // Python `Environment.detect` returns `platform.system()` verbatim
    // for unknown OS strings; TS mirrors that behaviour.
    expect(env.osKind).toBe('freebsd');
  });

  // ── POSIX shell probing ────────────────────────────────────────────

  it('prefers /bin/bash when it exists (shellName=bash)', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName satisfies ShellName).toBe('bash');
    expect(env.shellPath).toBe('/bin/bash');
  });

  it('falls back to /usr/bin/bash when /bin/bash is missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/usr/bin/bash', '/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('/usr/bin/bash');
  });

  it('falls back to /usr/local/bin/bash when /bin and /usr/bin are missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('/usr/local/bin/bash');
  });

  it('falls back to /bin/sh with shellName=sh when no bash is found', async () => {
    const env = await detectEnvironment(stubDeps({ platform: 'linux', existingPaths: [] }));
    expect(env.shellName).toBe('sh');
    expect(env.shellPath).toBe('/bin/sh');
  });

  // ── Windows Git Bash probing ───────────────────────────────────────

  it('uses KIMI_SHELL_PATH override when set and the file exists', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { KIMI_SHELL_PATH: 'D:\\custom\\bash.exe' },
        existingPaths: ['D:\\custom\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName satisfies ShellName).toBe('bash');
    expect(env.shellPath).toBe('D:\\custom\\bash.exe');
  });

  it('infers Git Bash from git.exe on PATH when override is absent', async () => {
    const gitExe = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Program Files\\Git\\cmd' },
        existingPaths: [gitExe, 'C:\\Program Files\\Git\\bin\\bash.exe'],
        execFileText: async (file: string) => {
          throw new Error(`unexpected execFileText call for ${file}`);
        },
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('resolves a Scoop git shim through git --exec-path', async () => {
    const gitExe = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\me\\scoop\\shims' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]:
            'C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe');
  });

  it('resolves a Scoop git shim through usr/bin when bin/bash.exe is missing', async () => {
    const gitExe = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\me\\scoop\\shims' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]:
            'C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\Users\\me\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Users\\me\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe');
  });

  it('resolves MSYS2 ucrt64 native git through git --exec-path', async () => {
    const gitExe = 'C:\\msys64\\ucrt64\\bin\\git.exe';
    const env = await detectEnvironment(
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
    const env = await detectEnvironment(
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
    const env = await detectEnvironment(
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

  it('does not treat shim-adjacent bash.exe as the Git installation shell', async () => {
    const gitExe = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\me\\scoop\\shims' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]:
            'C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core\n',
        },
        existingPaths: [
          gitExe,
          'C:\\Users\\me\\scoop\\bin\\bash.exe',
          'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe',
        ],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe');
  });

  it('checks later git.exe matches when the first one cannot resolve Git Bash', async () => {
    const scoopGit = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const portableGit = 'D:\\PortableGit\\cmd\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\me\\scoop\\shims;D:\\PortableGit\\cmd' },
        existingPaths: [scoopGit, portableGit, 'D:\\PortableGit\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('D:\\PortableGit\\bin\\bash.exe');
  });

  it('keeps PATH order when an earlier shim resolves through git --exec-path', async () => {
    const scoopGit = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const portableGit = 'D:\\PortableGit\\cmd\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\me\\scoop\\shims;D:\\PortableGit\\cmd' },
        execFileResults: {
          [execFileKey(scoopGit, ['--exec-path'])]:
            'C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core\n',
        },
        existingPaths: [
          scoopGit,
          portableGit,
          'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe',
          'D:\\PortableGit\\bin\\bash.exe',
        ],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe');
  });

  it('skips relative Windows PATH entries before git --exec-path probing', async () => {
    const relativeGit = 'tools\\git.exe';
    const error = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'tools' },
        existingPaths: [relativeGit],
        execFileText: async (file: string) => {
          throw new Error(`unexpected execFileText call for ${file}`);
        },
      }),
    ).then(
      () => {
        throw new Error('expected throw');
      },
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(KaosShellNotFoundError);
  });

  it('scans PATH directly for git.exe candidates', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'D:\\PortableGit\\cmd' },
        existingPaths: ['D:\\PortableGit\\cmd\\git.exe', 'D:\\PortableGit\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('D:\\PortableGit\\bin\\bash.exe');
  });

  it('infers Git Bash from usr/bin when bin/bash.exe is missing', async () => {
    const gitExe = 'D:\\Program Files\\Git\\cmd\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'D:\\Program Files\\Git\\cmd' },
        existingPaths: [gitExe, 'D:\\Program Files\\Git\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('D:\\Program Files\\Git\\usr\\bin\\bash.exe');
  });

  it('falls back to the well-known Program Files install location', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        existingPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('falls back to usr/bin under Program Files when bin/bash.exe is missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        existingPaths: ['C:\\Program Files\\Git\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  });

  it('falls back to LOCALAPPDATA install when present', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        existingPaths: ['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellPath).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  });

  it('falls back to usr/bin under LOCALAPPDATA when bin/bash.exe is missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        existingPaths: ['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellPath).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe');
  });

  it('throws KaosShellNotFoundError when no Git Bash candidate is found', async () => {
    const error = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        existingPaths: [],
      }),
    ).then(
      () => {
        throw new Error('expected throw');
      },
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(KaosShellNotFoundError);
  });

  it('includes attempted paths in the thrown error message', async () => {
    const error = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { KIMI_SHELL_PATH: 'D:\\custom\\bash.exe' },
        existingPaths: [],
      }),
    ).then(
      () => {
        throw new Error('expected throw');
      },
      (error: unknown) => error as KaosShellNotFoundError,
    );
    expect(error.message).toContain('D:\\custom\\bash.exe');
    expect(error.message).toContain('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(error.message).toContain('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  });

  // ── arch / version passthrough ─────────────────────────────────────

  it('reports osArch verbatim from the injected probe', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'darwin', arch: 'arm64', existingPaths: ['/bin/bash'] }),
    );
    expect(env.osArch).toBe('arm64');
  });

  it('reports osVersion verbatim from the injected probe', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        release: '6.1.0-test',
        existingPaths: ['/bin/bash'],
      }),
    );
    expect(env.osVersion).toBe('6.1.0-test');
  });
});

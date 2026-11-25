import { describe, expect, it } from 'vitest';

import {
  probeHostEnvironment,
  probeHostEnvironmentFromNode,
  ProbeShellNotFoundError,
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
  it('can select Bash for a single Windows host without changing user shell discovery', async () => {
    const system = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const bundled = 'D:\\Desktop\\usr\\bin\\bash.exe';
    const host = stubDeps({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, existingPaths: [system, bundled] });
    await expect(probeHostEnvironment({ ...host, windowsShellPath: bundled })).resolves.toMatchObject({ shellPath: bundled });
    await expect(probeHostEnvironment(host)).resolves.toMatchObject({ shellPath: system });
    expect(host.env).toEqual({ PATH: 'C:\\Windows\\System32' });
  });

  it('does not reuse or replace the default Node probe for a scoped Windows shell', async () => {
    const parent = probeHostEnvironmentFromNode();
    const explicit = probeHostEnvironmentFromNode(process.execPath);
    expect(explicit).not.toBe(parent);
    const [defaultHost, scoped] = await Promise.all([parent.catch((error: unknown) => {
      if (process.platform === 'win32' && error instanceof ProbeShellNotFoundError) return undefined;
      throw error;
    }), explicit]);
    expect(scoped.shellPath).toBe(process.platform === 'win32' ? process.execPath : defaultHost?.shellPath);
    expect(probeHostEnvironmentFromNode()).toBe(parent);
  });

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

  it('throws ProbeShellNotFoundError when Git Bash is missing on Windows', async () => {
    const rejected: unknown = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Windows\\System32' },
        existingPaths: [],
      }),
    ).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(ProbeShellNotFoundError);
    const probeError = rejected as ProbeShellNotFoundError;
    expect(probeError.message).toContain('https://gitforwindows.org/');
    expect(probeError.message).not.toContain('Checked:');
    expect(probeError.checked.length).toBeGreaterThan(0);
  });
});

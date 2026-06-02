import type { Environment } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { evaluateDependencies, type DependencyProbe } from '#/cli/system-deps/check';

const POSIX_ENV: Environment = {
  osKind: 'macOS',
  osArch: 'arm64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
};

const WINDOWS_NO_SHELL: Environment = {
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: '10.0.22631.0',
  shellName: 'bash',
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  shellAvailable: false,
  shellUnavailableReason: 'Git Bash was not found on this Windows host.',
};

function probe(overrides: Partial<DependencyProbe> = {}): DependencyProbe {
  return {
    environment: POSIX_ENV,
    fdAvailable: true,
    rgOnSystemPath: true,
    rgBootstrappable: true,
    isGitRepo: true,
    ...overrides,
  };
}

function statusFor(id: string, p: DependencyProbe) {
  const status = evaluateDependencies(p).find((s) => s.dependency.id === id);
  if (status === undefined) throw new Error(`no status for ${id}`);
  return status;
}

describe('evaluateDependencies', () => {
  it('reports ripgrep as available even when not on PATH (auto-downloads)', () => {
    const onPath = statusFor('ripgrep', probe({ rgOnSystemPath: true }));
    expect(onPath.available).toBe(true);
    expect(onPath.shouldWarnAtStartup).toBe(false);
    expect(onPath.detail).toContain('system PATH');

    const offPath = statusFor('ripgrep', probe({ rgOnSystemPath: false }));
    expect(offPath.available).toBe(true);
    expect(offPath.shouldWarnAtStartup).toBe(false);
    expect(offPath.detail).toContain('downloaded');
  });

  it('warns for ripgrep when not on PATH and not bootstrappable for this platform', () => {
    const status = statusFor(
      'ripgrep',
      probe({ rgOnSystemPath: false, rgBootstrappable: false }),
    );
    expect(status.available).toBe(false);
    expect(status.shouldWarnAtStartup).toBe(true);
    expect(status.detail).toContain('no prebuilt binary');
  });

  it('warns for fd missing outside a git repository', () => {
    const status = statusFor('fd', probe({ fdAvailable: false, isGitRepo: false }));
    expect(status.available).toBe(false);
    expect(status.shouldWarnAtStartup).toBe(true);
    expect(status.detail).toContain('not in a git repository');
  });

  it('stays quiet for fd missing inside a git repository (git ls-files fallback)', () => {
    const status = statusFor('fd', probe({ fdAvailable: false, isGitRepo: true }));
    // The capability is satisfied via the fallback, so it counts as available.
    expect(status.available).toBe(true);
    expect(status.shouldWarnAtStartup).toBe(false);
    expect(status.detail).toContain('git ls-files');
  });

  it('stays quiet when fd is available outside a git repository', () => {
    const status = statusFor('fd', probe({ fdAvailable: true, isGitRepo: false }));
    expect(status.available).toBe(true);
    expect(status.shouldWarnAtStartup).toBe(false);
  });

  it('warns when the shell is unavailable and surfaces the probe reason', () => {
    const status = statusFor('shell', probe({ environment: WINDOWS_NO_SHELL }));
    expect(status.available).toBe(false);
    expect(status.shouldWarnAtStartup).toBe(true);
    expect(status.detail).toContain('Git Bash was not found');
  });

  it('treats a shell as available when shellAvailable is undefined (POSIX)', () => {
    const status = statusFor('shell', probe({ environment: POSIX_ENV }));
    expect(status.available).toBe(true);
    expect(status.shouldWarnAtStartup).toBe(false);
    expect(status.detail).toContain('/bin/bash');
  });

  it('covers every registered dependency exactly once', () => {
    const ids = evaluateDependencies(probe()).map((s) => s.dependency.id);
    expect(ids).toEqual(['ripgrep', 'fd', 'shell']);
  });
});

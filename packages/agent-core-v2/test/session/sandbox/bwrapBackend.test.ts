/**
 * BwrapSandboxBackend tests for the v2 sandbox domain.
 *
 * Covers the availability probe (`detect` exit-code mapping, spawn failures)
 * and the generated bwrap argv: writable binds, `denyRead` masking per path
 * kind (dir → `--tmpfs`, file → `--ro-bind /dev/null`, missing → skipped),
 * `denyWrite` read-only overrides limited to the writable roots, network
 * unsharing, and bind ordering (all masks after the writable binds). Path
 * classification is injected, so no real filesystem is touched.
 */

import { describe, expect, it, vi } from 'vitest';

import { BWRAP_DETECT_ARGV, BwrapSandboxBackend } from '#/session/sandbox/backends/bwrapBackend';
import type { PathKind } from '#/session/sandbox/backends/sandboxBackend';
import type { ResolvedSandboxPolicy } from '#/session/sandbox/sandboxTypes';

function policy(overrides: Partial<ResolvedSandboxPolicy> = {}): ResolvedSandboxPolicy {
  return {
    mode: 'workspace-write',
    writableRoots: ['/workspace/app', '/tmp'],
    denyRead: [],
    denyWrite: [],
    networkEnabled: false,
    ...overrides,
  };
}

function pathKindOf(table: Record<string, PathKind>): (p: string) => PathKind {
  return (p) => table[p] ?? 'missing';
}

describe('BwrapSandboxBackend.detect', () => {
  it('is available when the probe exits 0', async () => {
    const spawn = vi.fn(async () => 0);
    await expect(new BwrapSandboxBackend().detect(spawn)).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledWith([...BWRAP_DETECT_ARGV]);
  });

  it('is unavailable on non-zero exit or spawn failure', async () => {
    await expect(new BwrapSandboxBackend().detect(async () => 1)).resolves.toBe(false);
    await expect(
      new BwrapSandboxBackend().detect(async () => {
        throw new Error('ENOENT');
      }),
    ).resolves.toBe(false);
  });
});

describe('BwrapSandboxBackend.wrap', () => {
  it('builds the base argv with writable binds, network unshare, and the command after --', () => {
    const backend = new BwrapSandboxBackend(() => 'dir');
    const argv = backend.wrap(['/bin/bash', '-c', 'echo ok'], policy());

    expect(argv).toEqual([
      'bwrap',
      '--die-with-parent',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--bind', '/workspace/app', '/workspace/app',
      '--bind', '/tmp', '/tmp',
      '--unshare-net',
      '--',
      '/bin/bash', '-c', 'echo ok',
    ]);
  });

  it('keeps the network shared when networkEnabled is true', () => {
    const backend = new BwrapSandboxBackend(() => 'dir');
    const argv = backend.wrap(['true'], policy({ networkEnabled: true }));

    expect(argv).not.toContain('--unshare-net');
  });

  it('skips writable roots that do not exist', () => {
    const backend = new BwrapSandboxBackend(pathKindOf({ '/workspace/app': 'dir' }));
    const argv = backend.wrap(['true'], policy());

    const bindPairs: string[][] = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--bind') bindPairs.push([argv[i + 1]!, argv[i + 2]!]);
    }
    expect(bindPairs).toEqual([['/workspace/app', '/workspace/app']]);
  });

  it('masks denyRead dirs with --tmpfs and files with /dev/null, skipping missing paths', () => {
    const backend = new BwrapSandboxBackend(
      pathKindOf({
        '/workspace/app': 'dir',
        '/tmp': 'dir',
        '/home/test/.ssh': 'dir',
        '/home/test/.aws/credentials': 'file',
      }),
    );
    const argv = backend.wrap(
      ['true'],
      policy({
        denyRead: ['/home/test/.ssh', '/home/test/.aws/credentials', '/does/not/exist'],
      }),
    );

    expect(argv).toEqual(expect.arrayContaining(['--tmpfs', '/home/test/.ssh']));
    expect(argv).toEqual(
      expect.arrayContaining(['--ro-bind', '/dev/null', '/home/test/.aws/credentials']),
    );
    expect(argv).not.toContain('/does/not/exist');
  });

  it('applies denyWrite as a read-only re-bind after the writable binds, only within writable roots', () => {
    const backend = new BwrapSandboxBackend(
      pathKindOf({
        '/workspace/app': 'dir',
        '/tmp': 'dir',
        '/workspace/app/.git': 'dir',
      }),
    );
    const argv = backend.wrap(
      ['true'],
      policy({
        denyWrite: [
          '/workspace/app/.git', // inside a writable root → overridden read-only
          '/etc', // outside writable roots → already read-only, skipped
          '/workspace/app/missing', // missing → skipped
        ],
      }),
    );

    expect(argv).toEqual(expect.arrayContaining(['--ro-bind', '/workspace/app/.git', '/workspace/app/.git']));
    expect(argv).not.toContain('/etc');
    expect(argv).not.toContain('/workspace/app/missing');
    expect(argv.indexOf('/workspace/app/.git')).toBeGreaterThan(argv.lastIndexOf('--bind'));
  });

  it('orders every mask after all writable binds', () => {
    const backend = new BwrapSandboxBackend(
      pathKindOf({
        '/workspace/app': 'dir',
        '/tmp': 'dir',
        '/workspace/app/.ssh': 'dir',
        '/workspace/app/.git': 'dir',
      }),
    );
    const argv = backend.wrap(
      ['true'],
      policy({ denyRead: ['/workspace/app/.ssh'], denyWrite: ['/workspace/app/.git'] }),
    );

    const lastBind = argv.lastIndexOf('--bind');
    expect(argv.lastIndexOf('--tmpfs')).toBeGreaterThan(lastBind);
    expect(argv.indexOf('/workspace/app/.git')).toBeGreaterThan(lastBind);
  });
});

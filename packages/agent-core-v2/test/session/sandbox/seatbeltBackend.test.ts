/**
 * SeatbeltSandboxBackend tests for the v2 sandbox domain.
 *
 * Covers the availability probe and the generated SBPL profile: `(deny
 * default)` baseline with a conservative allow set, explicit `deny file-read*`
 * masks (which beat the broad read allow), writable-root `allow file-write*`,
 * `deny file-write*` overrides, the network gate, and SBPL string escaping.
 * No macOS host is required — the profile is asserted as text.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SEATBELT_DETECT_ARGV,
  SeatbeltSandboxBackend,
  buildSeatbeltProfile,
} from '#/session/sandbox/backends/seatbeltBackend';
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

describe('SeatbeltSandboxBackend.detect', () => {
  it('is available when the probe exits 0', async () => {
    const spawn = vi.fn(async () => 0);
    await expect(new SeatbeltSandboxBackend().detect(spawn)).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledWith([...SEATBELT_DETECT_ARGV]);
  });

  it('is unavailable on non-zero exit or spawn failure', async () => {
    await expect(new SeatbeltSandboxBackend().detect(async () => 1)).resolves.toBe(false);
    await expect(
      new SeatbeltSandboxBackend().detect(async () => {
        throw new Error('ENOENT');
      }),
    ).resolves.toBe(false);
  });
});

describe('SeatbeltSandboxBackend.wrap', () => {
  it('prefixes the argv with sandbox-exec -p <profile>', () => {
    const argv = new SeatbeltSandboxBackend().wrap(['/bin/zsh', '-c', 'echo ok'], policy());

    expect(argv[0]).toBe('sandbox-exec');
    expect(argv[1]).toBe('-p');
    expect(argv.slice(3)).toEqual(['/bin/zsh', '-c', 'echo ok']);
  });
});

describe('buildSeatbeltProfile', () => {
  it('denies by default with a conservative process/read baseline and writable roots', () => {
    const profile = buildSeatbeltProfile(policy());

    expect(profile).toMatchInlineSnapshot(`
      "(version 1)
      (deny default)
      (allow process-exec)
      (allow process-fork)
      (allow signal (target self))
      (allow sysctl-read)
      (allow mach-lookup)
      (allow ipc-posix-shm)
      (allow file-read*)
      (allow file-write* (subpath "/workspace/app"))
      (allow file-write* (subpath "/tmp"))"
    `);
  });

  it('emits deny rules for denyRead / denyWrite (deny beats allow in seatbelt)', () => {
    const profile = buildSeatbeltProfile(
      policy({
        denyRead: ['/Users/test/.ssh'],
        denyWrite: ['/workspace/app/.git'],
      }),
    );

    expect(profile).toContain('(deny file-read* (subpath "/Users/test/.ssh"))');
    expect(profile).toContain('(deny file-write* (subpath "/workspace/app/.git"))');
    expect(profile.indexOf('(deny file-read*')).toBeGreaterThan(profile.indexOf('(allow file-read*)'));
    expect(profile.indexOf('(deny file-write*')).toBeGreaterThan(
      profile.indexOf('(allow file-write*'),
    );
  });

  it('allows the network only when networkEnabled is true', () => {
    expect(buildSeatbeltProfile(policy())).not.toContain('network');
    expect(buildSeatbeltProfile(policy({ networkEnabled: true }))).toContain('(allow network*)');
  });

  it('escapes backslashes and double quotes in paths', () => {
    const profile = buildSeatbeltProfile(
      policy({ writableRoots: ['/odd/path\\with"quote'], denyRead: [], denyWrite: [] }),
    );

    expect(profile).toContain('(allow file-write* (subpath "/odd/path\\\\with\\"quote"))');
  });
});
